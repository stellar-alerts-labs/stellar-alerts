import crypto from 'crypto';

/**
 * Short-lived signed download links for export files (#321).
 *
 * A link is `?expires=<unix seconds>&sig=<hex HMAC-SHA256>` over
 * `export-download:v1:<jobId>:<ownerUserId>:<expires>`. The owner id is part of
 * the signed data but not of the URL, so a link is only valid for the job it
 * was minted for, for the user who owns that job, and until `expires`.
 * The signing key is derived from `secret` (JWT_SECRET) with a fixed label so
 * it can never be confused with a JWT signature.
 */

const SIGNING_LABEL = 'export-download:v1';
const SIG_PATTERN = /^[0-9a-f]{64}$/;

function deriveKey(secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(SIGNING_LABEL).digest();
}

function computeSignature(secret: string, jobId: string, userId: string, expires: number): string {
  return crypto
    .createHmac('sha256', deriveKey(secret))
    .update(`${SIGNING_LABEL}:${jobId}:${userId}:${expires}`)
    .digest('hex');
}

export interface SignedDownload {
  expires: number;
  sig: string;
  expiresAt: Date;
}

export function signDownload(
  secret: string,
  jobId: string,
  userId: string,
  ttlSeconds: number,
  now: number = Date.now(),
): SignedDownload {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  return {
    expires,
    sig: computeSignature(secret, jobId, userId, expires),
    expiresAt: new Date(expires * 1000),
  };
}

export type DownloadVerification = 'valid' | 'expired' | 'invalid';

export function verifyDownloadSignature(
  secret: string,
  jobId: string,
  userId: string,
  expires: number,
  sig: string,
  now: number = Date.now(),
): DownloadVerification {
  if (!Number.isSafeInteger(expires) || typeof sig !== 'string' || !SIG_PATTERN.test(sig)) {
    return 'invalid';
  }

  const expected = Buffer.from(computeSignature(secret, jobId, userId, expires), 'hex');
  const provided = Buffer.from(sig, 'hex');
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return 'invalid';
  }

  return expires * 1000 <= now ? 'expired' : 'valid';
}
