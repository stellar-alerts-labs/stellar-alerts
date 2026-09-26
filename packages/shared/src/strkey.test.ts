import { describe, it, expect } from 'vitest';
import {
  StellarValidationError,
  assertValidContractId,
  assertValidEd25519PublicKey,
  assertValidMuxedAddress,
  assertValidTransactionHash,
  isValidContractId,
  isValidEd25519PublicKey,
  isValidMuxedAddress,
  isValidTransactionHash,
  normalizeTransactionHash,
  parseMuxedAddress,
  validateContractId,
  validateEd25519PublicKey,
  validateMuxedAddress,
  validateTransactionHash,
} from './strkey';

/**
 * Ed25519 account values. StrKey encoding is network-agnostic, so a valid key
 * is valid on both mainnet and testnet; the fixtures below include the
 * all-zero account, a widely used mainnet/testnet example and a value from the
 * API's watcher fixtures.
 */
const VALID_ED25519_KEYS = [
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
  'GAFBOJBRHZFVQZLSP6GJTJVTYDG5VZ7UAEHBWKBVIJHVY2LWQOIJ3NUB',
  'GAIR4KZYIVJF63DZQ2J2BLN2Y7KOD3X3BAKSELZ4JFLGG4D5RKL2IC5J',
  'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
];

/** Native asset-contract IDs published for mainnet and testnet. */
const MAINNET_CONTRACT_ID = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
const TESTNET_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const OTHER_CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

/** SEP-23 muxed example: account GA7QYNF7...SGZ with id 9223372036854775808. */
const SEP23_MUXED_ADDRESS =
  'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';
const SEP23_UNDERLYING_ACCOUNT = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

/** Null account with mux id 0 / 1, and a non-zero account with id 42. */
const NULL_ACCOUNT_MUXED_ID_0 =
  'MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5IG';
const NULL_ACCOUNT_MUXED_ID_1 =
  'MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFNZG';
const ACCOUNT_MUXED_ID_42 =
  'MAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSAAAAAAAAAAAAFIJUA';
const ACCOUNT_MUXED_ID_42_ACCOUNT = 'GAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSABOV';

/** Valid StrKeys with non-account version bytes (S = seed, X = hashX). */
const ED25519_SEED = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSU2';
const HASH_X = 'XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPQN';

const TX_HASH = 'ab'.repeat(32); // 64 lowercase hex chars

/** Flips the final base32 char, corrupting the CRC16 checksum. */
function corruptChecksum(value: string): string {
  const last = value.slice(-1);
  return value.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

describe('validateEd25519PublicKey / isValidEd25519PublicKey', () => {
  it('accepts valid network-agnostic Ed25519 public keys', () => {
    for (const key of VALID_ED25519_KEYS) {
      expect(isValidEd25519PublicKey(key)).toBe(true);
      expect(validateEd25519PublicKey(key)).toEqual({
        valid: true,
        kind: 'ed25519PublicKey',
        value: key,
      });
    }
  });

  it('rejects an empty string', () => {
    expect(isValidEd25519PublicKey('')).toBe(false);
    expect(validateEd25519PublicKey('')).toMatchObject({ valid: false, reason: 'empty' });
  });

  it('rejects non-string input', () => {
    expect(isValidEd25519PublicKey(null)).toBe(false);
    expect(isValidEd25519PublicKey(undefined)).toBe(false);
    expect(isValidEd25519PublicKey(42)).toBe(false);
    expect(validateEd25519PublicKey(null)).toMatchObject({
      valid: false,
      reason: 'not_a_string',
      value: null,
    });
  });

  it('rejects boundary lengths (55 and 57 characters)', () => {
    const key = VALID_ED25519_KEYS[1];
    expect(isValidEd25519PublicKey(key.slice(0, 55))).toBe(false);
    expect(isValidEd25519PublicKey(key + 'A')).toBe(false);
    expect(validateEd25519PublicKey(key + 'A')).toMatchObject({
      valid: false,
      reason: 'wrong_length',
    });
  });

  it('rejects lowercase and non-base32 characters', () => {
    const key = VALID_ED25519_KEYS[1];
    expect(isValidEd25519PublicKey(key.toLowerCase())).toBe(false);
    expect(isValidEd25519PublicKey(key.slice(0, 54) + '1' + 'A')).toBe(false);
    expect(isValidEd25519PublicKey(key.slice(0, 54) + '0' + 'A')).toBe(false);
  });

  it('rejects a corrupted CRC16-XMODEM checksum', () => {
    const corrupted = corruptChecksum(VALID_ED25519_KEYS[1]);
    expect(isValidEd25519PublicKey(corrupted)).toBe(false);
    expect(validateEd25519PublicKey(corrupted)).toMatchObject({
      valid: false,
      reason: 'invalid_checksum',
    });
  });

  it('rejects StrKeys with a different version byte', () => {
    expect(isValidEd25519PublicKey(TESTNET_CONTRACT_ID)).toBe(false);
    expect(validateEd25519PublicKey(TESTNET_CONTRACT_ID)).toMatchObject({
      valid: false,
      reason: 'wrong_version_byte',
    });
    expect(isValidEd25519PublicKey(ED25519_SEED)).toBe(false);
    expect(isValidEd25519PublicKey(HASH_X)).toBe(false);
    expect(isValidEd25519PublicKey(VALID_ED25519_KEYS[0].replace('G', 'M'))).toBe(false);
  });
});

describe('validateContractId / isValidContractId', () => {
  it('accepts valid mainnet and testnet contract IDs', () => {
    for (const id of [MAINNET_CONTRACT_ID, TESTNET_CONTRACT_ID, OTHER_CONTRACT_ID]) {
      expect(isValidContractId(id)).toBe(true);
      expect(validateContractId(id)).toEqual({ valid: true, kind: 'contractId', value: id });
    }
  });

  it('rejects an Ed25519 public key (wrong version byte)', () => {
    expect(isValidContractId(VALID_ED25519_KEYS[0])).toBe(false);
    expect(validateContractId(VALID_ED25519_KEYS[0])).toMatchObject({
      valid: false,
      reason: 'wrong_version_byte',
    });
  });

  it('rejects a corrupted checksum', () => {
    expect(isValidContractId(corruptChecksum(MAINNET_CONTRACT_ID))).toBe(false);
  });

  it('rejects malformed values and wrong lengths', () => {
    expect(isValidContractId('')).toBe(false);
    expect(isValidContractId('not-a-contract')).toBe(false);
    expect(isValidContractId(MAINNET_CONTRACT_ID.slice(0, 55))).toBe(false);
    expect(isValidContractId(MAINNET_CONTRACT_ID + 'A')).toBe(false);
    expect(isValidContractId(null)).toBe(false);
  });
});

describe('validateMuxedAddress / isValidMuxedAddress / parseMuxedAddress', () => {
  it('accepts valid muxed addresses (69 characters)', () => {
    for (const address of [
      SEP23_MUXED_ADDRESS,
      NULL_ACCOUNT_MUXED_ID_0,
      NULL_ACCOUNT_MUXED_ID_1,
      ACCOUNT_MUXED_ID_42,
    ]) {
      expect(isValidMuxedAddress(address)).toBe(true);
      expect(validateMuxedAddress(address)).toEqual({
        valid: true,
        kind: 'muxedAddress',
        value: address,
      });
    }
  });

  it('parses the underlying account and 64-bit id', () => {
    expect(parseMuxedAddress(SEP23_MUXED_ADDRESS)).toEqual({
      accountId: SEP23_UNDERLYING_ACCOUNT,
      id: '9223372036854775808',
    });
    expect(parseMuxedAddress(NULL_ACCOUNT_MUXED_ID_0)).toEqual({
      accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      id: '0',
    });
    expect(parseMuxedAddress(ACCOUNT_MUXED_ID_42)).toEqual({
      accountId: ACCOUNT_MUXED_ID_42_ACCOUNT,
      id: '42',
    });
  });

  it('returns null from parseMuxedAddress for invalid input', () => {
    expect(parseMuxedAddress(VALID_ED25519_KEYS[0])).toBeNull();
    expect(parseMuxedAddress('')).toBeNull();
    expect(parseMuxedAddress(null)).toBeNull();
  });

  it('rejects an Ed25519 public key and a corrupted checksum', () => {
    expect(isValidMuxedAddress(VALID_ED25519_KEYS[0])).toBe(false);
    expect(isValidMuxedAddress(corruptChecksum(SEP23_MUXED_ADDRESS))).toBe(false);
  });

  it('rejects boundary lengths (68 and 70 characters)', () => {
    expect(isValidMuxedAddress(SEP23_MUXED_ADDRESS.slice(0, 68))).toBe(false);
    expect(isValidMuxedAddress(SEP23_MUXED_ADDRESS + 'A')).toBe(false);
    expect(validateMuxedAddress(SEP23_MUXED_ADDRESS.slice(0, 68))).toMatchObject({
      valid: false,
      reason: 'wrong_length',
    });
  });

  it('rejects non-string input', () => {
    expect(isValidMuxedAddress(undefined)).toBe(false);
  });
});

describe('validateTransactionHash / isValidTransactionHash / normalizeTransactionHash', () => {
  it('accepts 64 hex characters, with or without a 0x prefix and in any case', () => {
    expect(isValidTransactionHash(TX_HASH)).toBe(true);
    expect(isValidTransactionHash(TX_HASH.toUpperCase())).toBe(true);
    expect(isValidTransactionHash(`0x${TX_HASH}`)).toBe(true);
    expect(isValidTransactionHash(`0X${TX_HASH.toUpperCase()}`)).toBe(true);
    expect(validateTransactionHash(TX_HASH)).toEqual({
      valid: true,
      kind: 'transactionHash',
      value: TX_HASH,
    });
  });

  it('normalizes to lowercase without the 0x prefix', () => {
    expect(normalizeTransactionHash(`0x${TX_HASH.toUpperCase()}`)).toBe(TX_HASH);
    expect(normalizeTransactionHash(TX_HASH)).toBe(TX_HASH);
  });

  it('rejects wrong-length hashes', () => {
    expect(isValidTransactionHash('a'.repeat(63))).toBe(false);
    expect(isValidTransactionHash('a'.repeat(65))).toBe(false);
    expect(isValidTransactionHash('')).toBe(false);
    expect(validateTransactionHash('a'.repeat(63))).toMatchObject({
      valid: false,
      reason: 'wrong_hash_length',
    });
  });

  it('rejects non-hex characters even at the right length', () => {
    expect(isValidTransactionHash('g'.repeat(64))).toBe(false);
    expect(isValidTransactionHash(`0x${'z'.repeat(64)}`)).toBe(false);
    expect(validateTransactionHash('g'.repeat(64))).toMatchObject({
      valid: false,
      reason: 'not_hex',
    });
  });

  it('rejects non-string input and returns null when normalizing', () => {
    expect(isValidTransactionHash(null)).toBe(false);
    expect(isValidTransactionHash(1234)).toBe(false);
    expect(normalizeTransactionHash(null)).toBeNull();
    expect(normalizeTransactionHash('not-a-hash')).toBeNull();
  });
});

describe('assertValid* helpers', () => {
  it('return the value unchanged for valid input', () => {
    expect(assertValidEd25519PublicKey(VALID_ED25519_KEYS[1])).toBe(VALID_ED25519_KEYS[1]);
    expect(assertValidContractId(TESTNET_CONTRACT_ID)).toBe(TESTNET_CONTRACT_ID);
    expect(assertValidMuxedAddress(SEP23_MUXED_ADDRESS)).toBe(SEP23_MUXED_ADDRESS);
    expect(assertValidTransactionHash(TX_HASH)).toBe(TX_HASH);
  });

  it('throw a typed StellarValidationError with a reason for invalid input', () => {
    expect(() => assertValidEd25519PublicKey('nope')).toThrow(StellarValidationError);
    try {
      assertValidEd25519PublicKey(VALID_ED25519_KEYS[1] + 'A');
      throw new Error('expected assertValidEd25519PublicKey to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StellarValidationError);
      const typed = error as StellarValidationError;
      expect(typed.kind).toBe('ed25519PublicKey');
      expect(typed.reason).toBe('wrong_length');
    }

    try {
      assertValidContractId(VALID_ED25519_KEYS[1]);
      throw new Error('expected assertValidContractId to throw');
    } catch (error) {
      expect((error as StellarValidationError).reason).toBe('wrong_version_byte');
    }

    expect(() => assertValidMuxedAddress('')).toThrow(StellarValidationError);
    expect(() => assertValidTransactionHash('xyz')).toThrow(StellarValidationError);
  });
});
