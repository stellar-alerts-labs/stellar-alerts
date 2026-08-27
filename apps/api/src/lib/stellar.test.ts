import { describe, it, expect, vi, afterEach } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import { stellar } from './stellar';

// Fluent mock matching the Horizon payments() call builder
// (.forAccount().order()/.cursor().limit().call()), so these tests never hit
// the real Horizon network.
function mockPaymentsChain(records: unknown[] = []) {
  const chain = {
    forAccount: vi.fn().mockReturnThis(),
    cursor: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    call: vi.fn().mockResolvedValue({ records }),
  };
  const spy = vi.spyOn(stellar.server, 'payments').mockReturnValue(chain as any);
  return { chain, spy };
}

describe('stellar.getRecentPayments / getPaymentsSince (StrKey guard)', () => {
  const validPublicKey = StellarSdk.Keypair.random().publicKey();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getRecentPayments never calls Horizon for a checksum-invalid public key', async () => {
    const lastChar = validPublicKey.at(-1);
    const corrupted = validPublicKey.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');
    expect(StellarSdk.StrKey.isValidEd25519PublicKey(corrupted)).toBe(false);

    const { spy } = mockPaymentsChain();
    const result = await stellar.getRecentPayments(corrupted, 10);

    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('getRecentPayments never calls Horizon for a malformed (non-StrKey) string', async () => {
    const { spy } = mockPaymentsChain();
    const result = await stellar.getRecentPayments('not-a-stellar-key', 10);

    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('getRecentPayments never calls Horizon for an empty public key', async () => {
    const { spy } = mockPaymentsChain();
    const result = await stellar.getRecentPayments('', 10);

    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('getRecentPayments queries Horizon for a valid public key', async () => {
    const record = { id: '1', paging_token: '1' };
    const { chain, spy } = mockPaymentsChain([record]);

    const result = await stellar.getRecentPayments(validPublicKey, 5);

    expect(spy).toHaveBeenCalled();
    expect(chain.forAccount).toHaveBeenCalledWith(validPublicKey);
    expect(chain.limit).toHaveBeenCalledWith(5);
    expect(result).toEqual([record]);
  });

  it('getPaymentsSince never calls Horizon for a checksum-invalid public key', async () => {
    const lastChar = validPublicKey.at(-1);
    const corrupted = validPublicKey.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');

    const { spy } = mockPaymentsChain();
    const result = await stellar.getPaymentsSince(corrupted, '0', 50);

    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('getPaymentsSince queries Horizon for a valid public key', async () => {
    const record = { id: '2', paging_token: '2' };
    const { chain, spy } = mockPaymentsChain([record]);

    const result = await stellar.getPaymentsSince(validPublicKey, '100', 50);

    expect(spy).toHaveBeenCalled();
    expect(chain.forAccount).toHaveBeenCalledWith(validPublicKey);
    expect(chain.cursor).toHaveBeenCalledWith('100');
    expect(result).toEqual([record]);
  });
});
