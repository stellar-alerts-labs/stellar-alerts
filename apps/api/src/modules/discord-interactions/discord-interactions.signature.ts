/**
 * signature.ts — Ed25519 request verification for Discord interactions.
 *
 * Discord signs every interaction request with its Ed25519 private key; the
 * API must reject anything whose `X-Signature-Ed25519` header does not verify
 * against the application's public key, otherwise anyone could drive alert
 * state changes. Discord also requires a PING/PONG handshake to register the
 * endpoint.
 *
 * @see https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint
 */
import crypto from 'node:crypto';

/**
 * DER/SPKI prefix for a raw 32-byte Ed25519 public key. Node's
 * `createPublicKey` needs a key object, and Discord only hands us the raw key.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Reject signatures whose timestamp is older than this (replay protection). */
export const DISCORD_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export type DiscordVerificationResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'malformed_key' | 'malformed_signature' | 'stale_timestamp' | 'invalid_signature' };

export interface VerifyDiscordSignatureInput {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: string | Buffer;
}

/**
 * Constant-time comparison of two hex strings of equal length.
 */
function hexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verify the raw Ed25519 signature Discord attaches to an interaction.
 */
export function verifyDiscordSignature(input: VerifyDiscordSignatureInput): boolean {
  const { publicKeyHex, signatureHex, timestamp, body } = input;
  if (!publicKeyHex || !signatureHex || !timestamp) return false;

  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return false;
  }

  const message = Buffer.concat([
    Buffer.from(timestamp, 'utf8'),
    typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
  ]);

  try {
    return crypto.verify(null, message, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** True when the interaction timestamp is within the replay tolerance window. */
export function isFreshDiscordTimestamp(
  timestamp: string,
  nowMs: number = Date.now(),
  toleranceMs: number = DISCORD_TIMESTAMP_TOLERANCE_MS,
): boolean {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed)) return false;
  // Discord sends seconds since epoch.
  const timestampMs = parsed * 1000;
  return Math.abs(nowMs - timestampMs) <= toleranceMs;
}

/**
 * Full request check: headers present, timestamp fresh, signature valid.
 * Signature is only computed after the cheap header/timestamp checks pass.
 */
export function verifyDiscordRequest(
  input: VerifyDiscordSignatureInput & { nowMs?: number; toleranceMs?: number },
): DiscordVerificationResult {
  const { publicKeyHex, signatureHex, timestamp } = input;
  if (!publicKeyHex || !signatureHex || !timestamp) {
    return { ok: false, reason: 'missing_headers' };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
    return { ok: false, reason: 'malformed_key' };
  }
  if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
    return { ok: false, reason: 'malformed_signature' };
  }
  if (!isFreshDiscordTimestamp(timestamp, input.nowMs, input.toleranceMs)) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  if (!verifyDiscordSignature(input)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true };
}

/** Test-only helper: derive a raw hex public key from a Node KeyObject. */
export function exportRawEd25519PublicKey(key: crypto.KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(der).subarray(ED25519_SPKI_PREFIX.length).toString('hex');
}

export { hexEquals };
