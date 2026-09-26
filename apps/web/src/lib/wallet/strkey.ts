import { isValidEd25519PublicKey } from '@stellar-alerts/shared';

/**
 * Validates a Stellar Ed25519 public key (`G...`) for immediate client-side
 * feedback. Delegates to the shared StrKey utility so the browser performs the
 * same version-byte + CRC16-XMODEM checksum validation as the API — the
 * previous shape-only check (56 chars, starts with `G`, base32 alphabet)
 * accepted malformed keys whose checksum did not match.
 *
 * @deprecated Prefer importing `isValidEd25519PublicKey` directly from
 * `@stellar-alerts/shared`. This alias is kept so existing callers and tests
 * continue to work.
 */
export function looksLikeStellarPublicKey(value: string): boolean {
  if (typeof value !== 'string') return false;
  // Preserve the previous user-facing behaviour of tolerating surrounding
  // whitespace; the shared validator itself requires the exact StrKey.
  return isValidEd25519PublicKey(value.trim());
}

export function truncateAddress(address: string, head = 6, tail = 6): string {
  if (address.length <= head + tail) return address;
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}
