import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifySlackSignature } from '../slack.signature';

const SECRET = 'test-slack-signing-secret';
const BODY = 'command=%2Fstellar&text=balance&user_id=U123';

function sign(body: string, secret: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;
}

function currentTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

describe('verifySlackSignature', () => {
  it('accepts a correctly signed request', () => {
    const timestamp = currentTimestamp();
    const signature = sign(BODY, SECRET, timestamp);

    const result = verifySlackSignature(BODY, signature, timestamp, SECRET);

    expect(result).toEqual({ valid: true });
  });

  it('accepts a signature sent inside single-element header arrays', () => {
    const timestamp = currentTimestamp();
    const signature = sign(BODY, SECRET, timestamp);

    const result = verifySlackSignature(
      BODY,
      [signature],
      [timestamp],
      SECRET,
    );

    expect(result.valid).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const timestamp = currentTimestamp();
    const signature = sign(BODY, 'some-other-secret', timestamp);

    const result = verifySlackSignature(BODY, signature, timestamp, SECRET);

    expect(result).toEqual({ valid: false, failure: 'invalid_signature' });
  });

  it('rejects a tampered body (signature computed over different bytes)', () => {
    const timestamp = currentTimestamp();
    const signature = sign(BODY, SECRET, timestamp);
    const tampered = BODY.replace('balance', 'alerts');

    const result = verifySlackSignature(tampered, signature, timestamp, SECRET);

    expect(result).toEqual({ valid: false, failure: 'invalid_signature' });
  });

  it('rejects signatures without the v0= prefix', () => {
    const timestamp = currentTimestamp();
    const signature = sign(BODY, SECRET, timestamp).replace('v0=', '');

    const result = verifySlackSignature(BODY, signature, timestamp, SECRET);

    expect(result).toEqual({ valid: false, failure: 'invalid_signature' });
  });

  it('rejects a missing signature header', () => {
    const timestamp = currentTimestamp();

    const result = verifySlackSignature(BODY, undefined, timestamp, SECRET);

    expect(result).toEqual({ valid: false, failure: 'missing_signature' });
  });

  it('rejects a missing timestamp header', () => {
    const timestamp = currentTimestamp();
    const signature = sign(BODY, SECRET, timestamp);

    const result = verifySlackSignature(BODY, signature, undefined, SECRET);

    expect(result).toEqual({ valid: false, failure: 'missing_timestamp' });
  });

  it('rejects a non-numeric timestamp', () => {
    const signature = sign(BODY, SECRET, currentTimestamp());

    const result = verifySlackSignature(BODY, signature, 'not-a-number', SECRET);

    expect(result).toEqual({ valid: false, failure: 'malformed_timestamp' });
  });

  it('rejects a timestamp older than five minutes (replay protection)', () => {
    const staleTimestamp = Math.floor(Date.now() / 1000 - 301).toString();
    const signature = sign(BODY, SECRET, staleTimestamp);

    const result = verifySlackSignature(BODY, signature, staleTimestamp, SECRET);

    expect(result).toEqual({ valid: false, failure: 'stale_timestamp' });
  });

  it('rejects a timestamp far in the future', () => {
    const futureTimestamp = Math.floor(Date.now() / 1000 + 400).toString();
    const signature = sign(BODY, SECRET, futureTimestamp);

    const result = verifySlackSignature(BODY, signature, futureTimestamp, SECRET);

    expect(result).toEqual({ valid: false, failure: 'stale_timestamp' });
  });

  it('accepts a timestamp within the five minute window', () => {
    const timestamp = Math.floor(Date.now() / 1000 - 290).toString();
    const signature = sign(BODY, SECRET, timestamp);

    const result = verifySlackSignature(BODY, signature, timestamp, SECRET);

    expect(result.valid).toBe(true);
  });

  it('fails closed when the signing secret is not configured', () => {
    const timestamp = currentTimestamp();
    const signature = sign(BODY, '', timestamp);

    const result = verifySlackSignature(BODY, signature, timestamp, undefined);

    expect(result).toEqual({ valid: false, failure: 'signing_secret_not_configured' });
  });
});
