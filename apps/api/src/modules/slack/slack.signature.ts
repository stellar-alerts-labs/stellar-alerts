import crypto from 'node:crypto';

const SLACK_SIGNATURE_PREFIX = 'v0=';
// Slack's documented replay-protection window: reject requests whose
// timestamp is more than five minutes away from the local clock.
const MAX_TIMESTAMP_AGE_SECONDS = 300;

export type SlackSignatureFailure =
  | 'signing_secret_not_configured'
  | 'missing_signature'
  | 'missing_timestamp'
  | 'malformed_timestamp'
  | 'stale_timestamp'
  | 'invalid_signature';

export interface SlackSignatureVerification {
  valid: boolean;
  failure?: SlackSignatureFailure;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Verifies an incoming Slack slash-command request using the scheme Slack
 * documents at https://api.slack.com/authentication/verifying-requests-from-slack:
 *
 *   base string = `v0:{x-slack-request-timestamp}:{raw request body}`
 *   signature   = HMAC-SHA256(base string, signing secret), hex-encoded,
 *                 sent as the `v0=`-prefixed `x-slack-signature` header.
 *
 * The comparison is timing-safe and requests older than five minutes are
 * rejected to blunt replay attacks. `rawBody` must be the exact raw payload
 * string Slack sent — re-serializing parsed form fields invalidates the HMAC.
 */
export function verifySlackSignature(
  rawBody: string,
  signatureHeader: string | string[] | undefined,
  timestampHeader: string | string[] | undefined,
  signingSecret: string | undefined,
  nowMs: number = Date.now(),
): SlackSignatureVerification {
  if (!signingSecret) {
    return { valid: false, failure: 'signing_secret_not_configured' };
  }

  const signature = firstHeaderValue(signatureHeader);
  if (!signature) {
    return { valid: false, failure: 'missing_signature' };
  }

  const timestamp = firstHeaderValue(timestampHeader);
  if (!timestamp) {
    return { valid: false, failure: 'missing_timestamp' };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { valid: false, failure: 'malformed_timestamp' };
  }

  const ageSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  if (ageSeconds > MAX_TIMESTAMP_AGE_SECONDS) {
    return { valid: false, failure: 'stale_timestamp' };
  }

  if (!signature.startsWith(SLACK_SIGNATURE_PREFIX)) {
    return { valid: false, failure: 'invalid_signature' };
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected =
    SLACK_SIGNATURE_PREFIX +
    crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  const matches =
    expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

  return matches ? { valid: true } : { valid: false, failure: 'invalid_signature' };
}
