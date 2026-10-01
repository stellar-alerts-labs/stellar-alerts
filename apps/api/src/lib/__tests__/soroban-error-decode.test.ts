/**
 * Tests for `decodeSorobanErrorFromXdr` (apps/api/src/lib/soroban.ts).
 *
 * The function exists to turn an opaque RPC `ScError` blob into a code a
 * caller can act on, so the code itself is the contract under test. The trap
 * it guards against is real and was live in this repo: `ScError` is a
 * single-value union, and only the `sceContract` arm holds a bare number. The
 * typed `ScErrorCode` arms hold an *enum instance*, so `typeof value === 'number'`
 * is false and a naive read reports code 0 for every host error. Each test
 * below asserts the real code survives the round-trip.
 */
import { describe, expect, it } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import { decodeSorobanErrorFromXdr } from '../soroban';

const X = StellarSdk.xdr;

function encode(error: StellarSdk.xdr.ScError): string {
  return error.toXDR('base64');
}

describe('decodeSorobanErrorFromXdr', () => {
  it('decodes a contract error code, which is the one arm holding a bare number', () => {
    const info = decodeSorobanErrorFromXdr(encode(X.ScError.sceContract(7)));

    expect(info).not.toBeNull();
    expect(info!.type).toBe('custom_error');
    expect(info!.code).toBe(7);
    expect(info!.message).toContain('7');
  });

  it('recovers the code from a typed ScErrorCode arm instead of collapsing to 0', () => {
    // scecInvalidInput is ScErrorCode value 2. This is the regression: the arm
    // payload is an enum instance, not a number.
    const code = X.ScErrorCode.scecInvalidInput();
    const info = decodeSorobanErrorFromXdr(encode(X.ScError.sceWasmVm(code)));

    expect(info).not.toBeNull();
    expect(info!.type).toBe('host_error');
    expect(info!.code).toBe(code.value);
    expect(info!.code).not.toBe(0);
  });

  it('names the host error rather than reporting an unknown code', () => {
    const info = decodeSorobanErrorFromXdr(
      encode(X.ScError.sceContext(X.ScErrorCode.scecInternalError())),
    );

    expect(info).not.toBeNull();
    expect(info!.message).toContain('scecInternalError');
    expect(info!.code).toBe(X.ScErrorCode.scecInternalError().value);
  });

  it('preserves the arm name in details so the origin is not lost', () => {
    const info = decodeSorobanErrorFromXdr(
      encode(X.ScError.sceCrypto(X.ScErrorCode.scecUnexpectedType())),
    );

    expect(info).not.toBeNull();
    expect(info!.details).toContain('sceCrypto');
  });

  it('covers every non-contract arm, since all of them carry an ScErrorCode', () => {
    // In this SDK every non-contract arm is declared ScErrorCode, so the code
    // must survive for all of them, not just the two sampled above.
    const code = X.ScErrorCode.scecInvalidInput();
    const arms = [
      'sceWasmVm', 'sceContext', 'sceStorage', 'sceObject', 'sceCrypto',
      'sceEvents', 'sceBudget', 'sceValue', 'sceAuth',
    ] as const;

    for (const arm of arms) {
      const info = decodeSorobanErrorFromXdr(encode(X.ScError[arm](code)));
      expect(info, arm).not.toBeNull();
      expect(info!.type, arm).toBe('host_error');
      expect(info!.code, arm).toBe(code.value);
      expect(info!.details, arm).toContain(arm);
    }
  });

  it('returns null for input that is not a decodable ScError', () => {
    expect(decodeSorobanErrorFromXdr('not-base64-xdr')).toBeNull();
    expect(decodeSorobanErrorFromXdr('')).toBeNull();
  });
});
