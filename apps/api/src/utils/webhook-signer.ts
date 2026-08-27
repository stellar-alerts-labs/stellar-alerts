import crypto from 'crypto';
import type Redis from 'ioredis';
import { redis } from '../lib/redis';
import { checkAndStoreNonce, generateNonce } from '../lib/nonceCache';

export interface WebhookHeaderResult {
  signature: string;
  timestamp: number;
  nonce: string;
  headerValue: string;
}

export interface VerifyWebhookOptions {
  toleranceMs?: number;
  nonce?: string;
  checkReplay?: boolean;
  redisClient?: Redis;
}

export const DEFAULT_DRIFT_TOLERANCE_MS = 300000; // 5 minutes

/**
 * Generates an HMAC SHA256 signature for a webhook payload with a UUIDv4 nonce
 * and Unix timestamp to prevent payload spoofing and replay attacks.
 *
 * @param payload   - The JSON payload string to sign.
 * @param secret    - The shared webhook signing secret.
 * @param timestamp - The Unix timestamp (milliseconds). Defaults to Date.now().
 * @param nonce     - The UUIDv4 nonce string. Defaults to a new cryptographically random UUID.
 */
export function generateWebhookSignature(
  payload: string,
  secret: string,
  timestamp: number = Date.now(),
  nonce: string = generateNonce()
): WebhookHeaderResult {
  const hmac = crypto.createHmac('sha256', secret);
  const dataToSign = nonce ? `${timestamp}.${nonce}.${payload}` : `${timestamp}.${payload}`;
  const signature = hmac.update(dataToSign).digest('hex');
  const headerValue = nonce
    ? `t=${timestamp},n=${nonce},v1=${signature}`
    : `t=${timestamp},v1=${signature}`;

  return {
    signature,
    timestamp,
    nonce,
    headerValue,
  };
}

/**
 * Verifies an incoming webhook signature header against a secret key, enforcing:
 * 1. Correct HMAC SHA256 signature matching payload, timestamp, and nonce.
 * 2. 5-minute clock drift tolerance (fails if request is older than 5 minutes or in future).
 * 3. Redis-backed nonce replay prevention (rejects previously processed nonces).
 *
 * @param payload            - The raw JSON payload received.
 * @param headerValue        - The value of X-Stellar-Signature (e.g. "t=...,n=...,v1=...").
 * @param secret             - The shared webhook secret.
 * @param optionsOrTolerance - Tolerance in ms (number) or VerifyWebhookOptions object.
 * @returns `true` if valid and fresh, `false` if forged, expired, or replayed.
 */
export async function verifyWebhookSignature(
  payload: string,
  headerValue: string,
  secret: string,
  optionsOrTolerance: number | VerifyWebhookOptions = DEFAULT_DRIFT_TOLERANCE_MS
): Promise<boolean> {
  const options: VerifyWebhookOptions =
    typeof optionsOrTolerance === 'number'
      ? { toleranceMs: optionsOrTolerance }
      : (optionsOrTolerance ?? {});

  const toleranceMs = options.toleranceMs ?? DEFAULT_DRIFT_TOLERANCE_MS;
  const checkReplay = options.checkReplay ?? true;
  const redisClient = options.redisClient ?? redis;

  if (!headerValue || !headerValue.includes('t=') || !headerValue.includes('v1=')) {
    return false;
  }

  const parts = headerValue.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const noncePart = parts.find((p) => p.startsWith('n='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) return false;

  const timestamp = parseInt(timestampPart.substring(2), 10);
  const signature = signaturePart.substring(3);
  const nonce = noncePart ? noncePart.substring(2) : (options.nonce || '');

  if (isNaN(timestamp)) return false;

  // Check clock drift tolerance (default 5 minutes)
  if (Math.abs(Date.now() - timestamp) > toleranceMs) {
    return false;
  }

  // Verify HMAC signature
  const expected = generateWebhookSignature(payload, secret, timestamp, nonce);
  const sigBuffer = Buffer.from(signature);
  const expBuffer = Buffer.from(expected.signature);

  if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
    // If no nonce was provided in header, try legacy format without nonce
    if (!noncePart && !options.nonce) {
      const legacyExpected = generateWebhookSignature(payload, secret, timestamp, '');
      const legacyExpBuffer = Buffer.from(legacyExpected.signature);
      if (
        sigBuffer.length !== legacyExpBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, legacyExpBuffer)
      ) {
        return false;
      }
    } else {
      return false;
    }
  }

  // Replay prevention: Check Redis cache
  if (nonce && checkReplay) {
    const ttlSeconds = Math.max(1, Math.ceil(toleranceMs / 1000));
    const isFresh = await checkAndStoreNonce(nonce, ttlSeconds, redisClient);
    if (!isFresh) {
      return false;
    }
  }

  return true;
}

/**
 * Synchronous verification helper for HMAC signature and timestamp drift only (without Redis check).
 */
export function verifyWebhookSignatureSync(
  payload: string,
  headerValue: string,
  secret: string,
  toleranceMs: number = DEFAULT_DRIFT_TOLERANCE_MS,
  nonceOverride?: string
): boolean {
  if (!headerValue || !headerValue.includes('t=') || !headerValue.includes('v1=')) {
    return false;
  }

  const parts = headerValue.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const noncePart = parts.find((p) => p.startsWith('n='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) return false;

  const timestamp = parseInt(timestampPart.substring(2), 10);
  const signature = signaturePart.substring(3);
  const nonce = noncePart ? noncePart.substring(2) : (nonceOverride || '');

  if (isNaN(timestamp)) return false;

  if (Math.abs(Date.now() - timestamp) > toleranceMs) {
    return false;
  }

  const expected = generateWebhookSignature(payload, secret, timestamp, nonce);
  const sigBuffer = Buffer.from(signature);
  const expBuffer = Buffer.from(expected.signature);

  if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
    if (!noncePart && !nonceOverride) {
      const legacyExpected = generateWebhookSignature(payload, secret, timestamp, '');
      const legacyExpBuffer = Buffer.from(legacyExpected.signature);
      return (
        sigBuffer.length === legacyExpBuffer.length &&
        crypto.timingSafeEqual(sigBuffer, legacyExpBuffer)
      );
    }
    return false;
  }

  return true;
}
