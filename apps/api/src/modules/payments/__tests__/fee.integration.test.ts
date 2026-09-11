/**
 * Integration test: Soroban fee estimation pipeline
 *
 * Tests the full path from PaymentsService.estimateFee() through
 * simulateTransaction() ensuring the pipeline correctly:
 *  - Marshals the XDR envelope to the RPC call
 *  - Parses ledger read/write footprints (persistent vs temporary)
 *  - Computes storage rent component
 *  - Returns fee values in both stroops and XLM
 *  - Handles simulation errors gracefully
 *
 * The Soroban RPC network call and Prisma are mocked so the test suite
 * runs offline without a live testnet endpoint or database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock prisma lib BEFORE any service imports to prevent env.ts from calling
// process.exit(1) when DATABASE_URL and other vars are missing in CI.
// ---------------------------------------------------------------------------
vi.mock('../../../lib/prisma', () => ({
  prisma: {
    payment: {
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 }, _count: { id: 0 } }),
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock stellar-sdk TransactionBuilder so fromXDR works without a real envelope
// ---------------------------------------------------------------------------
vi.mock('stellar-sdk', async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    TransactionBuilder: {
      ...original.TransactionBuilder,
      fromXDR: vi.fn().mockReturnValue({ fee: '200', toXDR: () => 'mock-xdr' }),
    },
  };
});

import { PaymentsService } from '../payments.service';
import { sorobanServer } from '../../../lib/soroban';

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

function buildMockLedgerKey(hexKey: string, durabilityName: 'persistent' | 'temporary') {
  return {
    toXDR: (_fmt: string) => hexKey,
    switch: () => ({
      name: durabilityName === 'temporary' ? 'temporary' : 'ledgerKeyContractData',
    }),
    contractData:
      durabilityName === 'persistent'
        ? () => ({ durability: () => ({ name: 'persistent' }) })
        : undefined,
  };
}

function buildSuccessSimResult(
  minResourceFee: string,
  readOnlyKeys: ReturnType<typeof buildMockLedgerKey>[],
  readWriteKeys: ReturnType<typeof buildMockLedgerKey>[]
) {
  return {
    minResourceFee,
    transactionData: {
      footprint: {
        readOnly: readOnlyKeys,
        readWrite: readWriteKeys,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsService.estimateFee – integration', () => {
  let service: PaymentsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PaymentsService();
  });

  it('returns a successful fee estimate with correct XLM conversion', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue(
      buildSuccessSimResult('7500000', [], []) as any
    );

    const result = await service.estimateFee('MOCK_XDR==');

    expect(result.success).toBe(true);
    // inclusion fee from mock tx.fee = '200'
    expect(result.inclusionFeeStroops).toBe('200');
    expect(result.resourceFeeStroops).toBe('7500000');
    // total = 200 + 7500000
    expect(result.totalFeeStroops).toBe('7500200');
    // 7500200 stroops = 0.7500200 XLM
    expect(result.totalFeeXlm).toBe('0.7500200');
  });

  it('correctly separates persistent and temporary ledger footprint entries', async () => {
    const persistentReadKey = buildMockLedgerKey('persist01', 'persistent');
    const temporaryWriteKey = buildMockLedgerKey('temp01', 'temporary');

    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue(
      buildSuccessSimResult('3000000', [persistentReadKey], [temporaryWriteKey]) as any
    );

    const result = await service.estimateFee('MOCK_XDR==');

    expect(result.success).toBe(true);
    expect(result.readCount).toBe(1);
    expect(result.writeCount).toBe(1);

    // Read entry should be persistent
    expect(result.readFootprint[0].key).toBe('persist01');
    expect(result.readFootprint[0].durability).toBe('persistent');

    // Write entry should be temporary
    expect(result.writeFootprint[0].key).toBe('temp01');
    expect(result.writeFootprint[0].durability).toBe('temporary');
  });

  it('includes rent fee component (≈ 30% of resource fee)', async () => {
    const minResourceFee = '4000000';
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue(
      buildSuccessSimResult(minResourceFee, [], []) as any
    );

    const result = await service.estimateFee('MOCK_XDR==');

    expect(result.success).toBe(true);
    const expectedRent = (BigInt(minResourceFee) * BigInt(30)) / BigInt(100);
    expect(BigInt(result.rentFeeStroops)).toBe(expectedRent);
    // Verify it's a non-zero value
    expect(Number(result.rentFeeStroops)).toBeGreaterThan(0);
  });

  it('handles multiple read and write footprint entries', async () => {
    const reads = [
      buildMockLedgerKey('ro001', 'persistent'),
      buildMockLedgerKey('ro002', 'persistent'),
      buildMockLedgerKey('ro003', 'temporary'),
    ];
    const writes = [
      buildMockLedgerKey('rw001', 'persistent'),
      buildMockLedgerKey('rw002', 'temporary'),
    ];

    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue(
      buildSuccessSimResult('2000000', reads, writes) as any
    );

    const result = await service.estimateFee('MOCK_XDR==');

    expect(result.readCount).toBe(3);
    expect(result.writeCount).toBe(2);
    expect(result.readFootprint.map((e) => e.key)).toEqual(['ro001', 'ro002', 'ro003']);
    expect(result.writeFootprint.map((e) => e.key)).toEqual(['rw001', 'rw002']);
  });

  it('returns success:false and captures error message on simulation failure', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
      error: 'HostError: value: ContractError(1)',
    } as any);

    const result = await service.estimateFee('MOCK_XDR==');

    expect(result.success).toBe(false);
    expect(result.error).toContain('HostError');
    expect(result.totalFeeStroops).toBe('0');
    expect(result.totalFeeXlm).toBe('0.0000000');
    expect(result.readFootprint).toEqual([]);
    expect(result.writeFootprint).toEqual([]);
  });

  it('returns success:false and captures error when RPC throws a network error', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockRejectedValue(
      new Error('ECONNREFUSED: soroban-testnet.stellar.org:443')
    );

    const result = await service.estimateFee('MOCK_XDR==');

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('total fee matches sum of inclusion + resource fees', async () => {
    // inclusion fee comes from mock TransactionBuilder.fromXDR's fee = '200'
    const resourceFee = '6543210';
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue(
      buildSuccessSimResult(resourceFee, [], []) as any
    );

    const result = await service.estimateFee('MOCK_XDR==');

    const expectedTotal =
      BigInt(result.inclusionFeeStroops) + BigInt(result.resourceFeeStroops);
    expect(BigInt(result.totalFeeStroops)).toBe(expectedTotal);
  });

  it('returns zero resource fee and empty footprints for a non-Soroban tx simulation', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
      minResourceFee: '0',
      transactionData: null,
    } as any);

    const result = await service.estimateFee('MOCK_XDR==');

    expect(result.success).toBe(true);
    expect(result.resourceFeeStroops).toBe('0');
    expect(result.rentFeeStroops).toBe('0');
    expect(result.readCount).toBe(0);
    expect(result.writeCount).toBe(0);
    expect(result.readFootprint).toEqual([]);
    expect(result.writeFootprint).toEqual([]);
  });
});
