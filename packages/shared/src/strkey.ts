/**
 * Shared, dependency-free Stellar StrKey validation.
 *
 * Stellar encodes Ed25519 public keys (`G...`), contract IDs (`C...`) and
 * muxed addresses (`M...`) as base32 strings whose first byte is a version
 * byte and whose last two bytes are a little-endian CRC16-XMODEM checksum over
 * the rest. This module is the single source of truth for validating those
 * values (plus transaction hashes) across `apps/api`, `apps/web` and
 * `packages/cli`. It replaces the previous shape-only checks
 * (`length === 56 && startsWith('G')`) that accepted any 56-char `G`-prefixed
 * string, including values with a corrupted checksum.
 *
 * Network note: StrKey encoding is network-agnostic. Mainnet and testnet share
 * the same version bytes and checksum algorithm, and the same key is valid on
 * either network — network selection happens through the network passphrase,
 * not the encoded address. The tests therefore pin example values published
 * for both networks.
 *
 * No third-party dependencies (in particular, no `stellar-sdk`) so this can be
 * imported by the browser, the API and the CLI alike.
 */

export type StellarStrKeyKind = 'ed25519PublicKey' | 'contractId' | 'muxedAddress';
export type StellarValueKind = StellarStrKeyKind | 'transactionHash';

export type StellarValidationReason =
  | 'not_a_string'
  | 'empty'
  | 'wrong_length'
  | 'invalid_base32'
  | 'wrong_version_byte'
  | 'invalid_checksum'
  | 'not_hex'
  | 'wrong_hash_length';

export type StellarValidationResult =
  | { valid: true; kind: StellarValueKind; value: string }
  | { valid: false; kind: StellarValueKind; reason: StellarValidationReason; value: string | null };

export interface MuxedAddressParts {
  /** The underlying Ed25519 account (`G...`) the muxed address belongs to. */
  accountId: string;
  /** The 64-bit mux id as an unsigned decimal string. */
  id: string;
}

/**
 * Thrown by the `assertValid*` helpers when a value fails validation. Carries a
 * machine-readable `kind`/`reason` so callers can react programmatically.
 */
export class StellarValidationError extends Error {
  readonly kind: StellarValueKind;
  readonly reason: StellarValidationReason;

  constructor(kind: StellarValueKind, reason: StellarValidationReason) {
    super(`Invalid Stellar ${kind}: ${reason}`);
    this.name = 'StellarValidationError';
    this.kind = kind;
    this.reason = reason;
    Object.setPrototypeOf(this, StellarValidationError.prototype);
  }
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** StrKey version bytes: account (6<<3), contract (2<<3), muxed (12<<3). */
const STRKEY_VERSION: Record<StellarStrKeyKind, number> = {
  ed25519PublicKey: 6 << 3,
  contractId: 2 << 3,
  muxedAddress: 12 << 3,
};

/** Canonical encoded length per kind (base32 of version + payload + CRC16). */
const STRKEY_LENGTH: Record<StellarStrKeyKind, number> = {
  ed25519PublicKey: 56,
  contractId: 56,
  muxedAddress: 69,
};

/** 32-byte hash as 64 hex chars, optionally `0x`-prefixed, case-insensitive. */
const TRANSACTION_HASH_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i;

function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];

  for (let i = 0; i < input.length; i++) {
    const index = BASE32_ALPHABET.indexOf(input[i]);
    if (index === -1) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  }

  // Leftover bits must be zero for a canonical encoding. A muxed address is
  // 43 bytes = 344 bits, so its final base32 char carries 4 data bits + 1 pad
  // bit that must be zero.
  if (bits > 0 && buffer !== 0) return null;

  return Uint8Array.from(bytes);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = '';

  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 0x1f];
    }
    buffer &= (1 << bits) - 1;
  }

  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return out;
}

/** CRC16-XMODEM, as used by Stellar StrKey (poly 0x1021, init 0x0000). */
function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function encodeStrKey(versionByte: number, payload: Uint8Array): string {
  const body = new Uint8Array(payload.length + 1);
  body[0] = versionByte;
  body.set(payload, 1);

  const checksum = crc16Xmodem(body);
  const full = new Uint8Array(body.length + 2);
  full.set(body, 0);
  full[body.length] = checksum & 0xff;
  full[body.length + 1] = (checksum >> 8) & 0xff;

  return base32Encode(full);
}

function decodeStrKey(
  value: unknown,
  kind: StellarStrKeyKind
): { ok: true; bytes: Uint8Array } | { ok: false; reason: StellarValidationReason; value: string | null } {
  if (typeof value !== 'string') return { ok: false, reason: 'not_a_string', value: null };
  if (value.length === 0) return { ok: false, reason: 'empty', value };
  if (value.length !== STRKEY_LENGTH[kind]) return { ok: false, reason: 'wrong_length', value };

  const decoded = base32Decode(value);
  if (!decoded) return { ok: false, reason: 'invalid_base32', value };
  if (decoded.length < 3) return { ok: false, reason: 'wrong_length', value };
  if (decoded[0] !== STRKEY_VERSION[kind]) {
    return { ok: false, reason: 'wrong_version_byte', value };
  }

  const payload = decoded.subarray(0, decoded.length - 2);
  const checksum = decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);
  if (crc16Xmodem(payload) !== checksum) return { ok: false, reason: 'invalid_checksum', value };

  return { ok: true, bytes: decoded };
}

/** Renders a big-endian byte array as an unsigned decimal string (no BigInt). */
function bytesToDecimalString(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let d = 0; d < digits.length; d++) {
      const next = digits[d] * 256 + carry;
      digits[d] = next % 10;
      carry = Math.floor(next / 10);
    }
    while (carry > 0) {
      digits.push(carry % 10);
      carry = Math.floor(carry / 10);
    }
  }
  return digits.reverse().join('');
}

/**
 * Validates any StrKey kind (Ed25519 public key, contract ID or muxed address)
 * and returns a discriminated result rather than throwing.
 */
export function validateStrKey(value: unknown, kind: StellarStrKeyKind): StellarValidationResult {
  const decoded = decodeStrKey(value, kind);
  if (decoded.ok) return { valid: true, kind, value: value as string };
  return { valid: false, kind, reason: decoded.reason, value: decoded.value };
}

export function validateEd25519PublicKey(value: unknown): StellarValidationResult {
  return validateStrKey(value, 'ed25519PublicKey');
}

export function validateContractId(value: unknown): StellarValidationResult {
  return validateStrKey(value, 'contractId');
}

export function validateMuxedAddress(value: unknown): StellarValidationResult {
  return validateStrKey(value, 'muxedAddress');
}

/**
 * Validates a transaction hash: 32 bytes of hex (64 characters), with or
 * without a `0x` prefix, case-insensitive.
 */
export function validateTransactionHash(value: unknown): StellarValidationResult {
  if (typeof value !== 'string') {
    return { valid: false, kind: 'transactionHash', reason: 'not_a_string', value: null };
  }
  if (value.length === 0) {
    return { valid: false, kind: 'transactionHash', reason: 'empty', value };
  }
  if (!TRANSACTION_HASH_PATTERN.test(value)) {
    const hexLength = value.replace(/^0x/i, '').length;
    return {
      valid: false,
      kind: 'transactionHash',
      reason: hexLength === 64 ? 'not_hex' : 'wrong_hash_length',
      value,
    };
  }
  return { valid: true, kind: 'transactionHash', value };
}

export function isValidEd25519PublicKey(value: unknown): value is string {
  return decodeStrKey(value, 'ed25519PublicKey').ok;
}

export function isValidContractId(value: unknown): value is string {
  return decodeStrKey(value, 'contractId').ok;
}

export function isValidMuxedAddress(value: unknown): value is string {
  return decodeStrKey(value, 'muxedAddress').ok;
}

export function isValidTransactionHash(value: unknown): value is string {
  return TRANSACTION_HASH_PATTERN.test(typeof value === 'string' ? value : '');
}

function assertValidStrKey(value: unknown, kind: StellarStrKeyKind): string {
  const result = validateStrKey(value, kind);
  if (result.valid) return result.value;
  throw new StellarValidationError(kind, result.reason);
}

export function assertValidEd25519PublicKey(value: unknown): string {
  return assertValidStrKey(value, 'ed25519PublicKey');
}

export function assertValidContractId(value: unknown): string {
  return assertValidStrKey(value, 'contractId');
}

export function assertValidMuxedAddress(value: unknown): string {
  return assertValidStrKey(value, 'muxedAddress');
}

export function assertValidTransactionHash(value: unknown): string {
  const result = validateTransactionHash(value);
  if (result.valid) return result.value;
  throw new StellarValidationError('transactionHash', result.reason);
}

/**
 * Normalizes a transaction hash to lowercase without the `0x` prefix, or
 * returns `null` when the value is not a valid hash.
 */
export function normalizeTransactionHash(value: unknown): string | null {
  if (!isValidTransactionHash(value)) return null;
  const hex = value.slice(0, 2).toLowerCase() === '0x' ? value.slice(2) : value;
  return hex.toLowerCase();
}

/**
 * Parses a muxed address (`M...`) into its underlying account (`G...`) and the
 * unsigned 64-bit mux id, or returns `null` when the value is invalid.
 */
export function parseMuxedAddress(value: unknown): MuxedAddressParts | null {
  const decoded = decodeStrKey(value, 'muxedAddress');
  if (!decoded.ok) return null;

  const bytes = decoded.bytes;
  return {
    accountId: encodeStrKey(STRKEY_VERSION.ed25519PublicKey, bytes.subarray(1, 33)),
    id: bytesToDecimalString(bytes.subarray(33, 41)),
  };
}
