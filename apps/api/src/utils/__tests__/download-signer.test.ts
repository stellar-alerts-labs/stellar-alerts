import { describe, it, expect } from 'vitest';
import { signDownload, verifyDownloadSignature } from '../download-signer';

const SECRET = 'test-secret';
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

describe('download-signer (#321)', () => {
  it('round-trips a freshly signed link as valid', () => {
    const signed = signDownload(SECRET, 'job-1', 'user-1', 300, NOW);

    expect(signed.expires).toBe(Math.floor(NOW / 1000) + 300);
    expect(signed.expiresAt.getTime()).toBe(signed.expires * 1000);
    expect(signed.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDownloadSignature(SECRET, 'job-1', 'user-1', signed.expires, signed.sig, NOW)).toBe('valid');
  });

  it('reports an elapsed link as expired', () => {
    const signed = signDownload(SECRET, 'job-1', 'user-1', 60, NOW);
    expect(
      verifyDownloadSignature(SECRET, 'job-1', 'user-1', signed.expires, signed.sig, NOW + 60_000),
    ).toBe('expired');
  });

  it.each([
    ['a different job', 'job-2', 'user-1', SECRET],
    ['a different owner', 'job-1', 'user-2', SECRET],
    ['a different secret', 'job-1', 'user-1', 'other-secret'],
  ])('rejects a signature minted for %s', (_label, jobId, userId, secret) => {
    const signed = signDownload(SECRET, 'job-1', 'user-1', 300, NOW);
    expect(verifyDownloadSignature(secret, jobId, userId, signed.expires, signed.sig, NOW)).toBe('invalid');
  });

  it('rejects a tampered expiry (extending the link)', () => {
    const signed = signDownload(SECRET, 'job-1', 'user-1', 300, NOW);
    expect(
      verifyDownloadSignature(SECRET, 'job-1', 'user-1', signed.expires + 3600, signed.sig, NOW),
    ).toBe('invalid');
  });

  it('rejects a tampered signature', () => {
    const signed = signDownload(SECRET, 'job-1', 'user-1', 300, NOW);
    const flipped = `${signed.sig.slice(0, -1)}${signed.sig.endsWith('0') ? '1' : '0'}`;
    expect(verifyDownloadSignature(SECRET, 'job-1', 'user-1', signed.expires, flipped, NOW)).toBe('invalid');
  });

  it.each([
    ['empty', ''],
    ['non-hex', 'z'.repeat(64)],
    ['too short', 'ab'],
    ['uppercase hex', 'A'.repeat(64)],
  ])('rejects a malformed (%s) signature without throwing', (_label, sig) => {
    expect(verifyDownloadSignature(SECRET, 'job-1', 'user-1', Math.floor(NOW / 1000) + 60, sig, NOW)).toBe('invalid');
  });

  it('rejects a non-integer expiry', () => {
    const signed = signDownload(SECRET, 'job-1', 'user-1', 300, NOW);
    expect(verifyDownloadSignature(SECRET, 'job-1', 'user-1', Number.NaN, signed.sig, NOW)).toBe('invalid');
    expect(verifyDownloadSignature(SECRET, 'job-1', 'user-1', 1.5, signed.sig, NOW)).toBe('invalid');
  });
});
