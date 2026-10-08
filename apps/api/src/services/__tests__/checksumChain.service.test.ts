import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(),
    paymentChecksum: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    dailyChecksumRoot: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { prisma } from '../../lib/prisma';
import { buildMerkleTree, hashMerkleLeaf } from '../../utils/merkle-verifier';
import {
  GENESIS_HASH,
  computePayloadHash,
  computeChainHash,
  appendPaymentChecksum,
  verifyChain,
  computeDailyMerkleRoot,
  verifyPaymentInDailyRoot,
  type ChainablePayment,
} from '../checksumChain.service';

function payment(overrides: Partial<ChainablePayment> = {}): ChainablePayment {
  return {
    id: 'payment-1',
    txHash: 'tx-hash-1',
    walletId: 'wallet-1',
    fromAddress: 'GABC...',
    amount: '100.5',
    asset: 'XLM',
    assetIssuer: null,
    memo: null,
    receivedAt: new Date('2026-09-01T12:00:00.000Z'),
    ...overrides,
  };
}

// Runs the transaction callback against `prisma` itself — the callback only
// calls tx.paymentChecksum.*, which is the same mocked surface as prisma.paymentChecksum.*.
function mockTransactionPassthrough() {
  (prisma.$transaction as any).mockImplementation(async (cb: any) => cb(prisma));
}

describe('checksumChain.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('appendPaymentChecksum', () => {
    it('links the very first row to the genesis hash', async () => {
      mockTransactionPassthrough();
      (prisma.paymentChecksum.findFirst as any).mockResolvedValue(null);
      (prisma.paymentChecksum.create as any).mockImplementation(async ({ data }: any) => ({
        id: 'checksum-1',
        sequence: 1,
        ...data,
      }));

      const p = payment();
      const result = await appendPaymentChecksum(p);

      const expectedPayloadHash = computePayloadHash(p);
      const expectedChainHash = computeChainHash(GENESIS_HASH, expectedPayloadHash);

      expect(result).toEqual({ chainHash: expectedChainHash });
      expect(prisma.paymentChecksum.create).toHaveBeenCalledWith({
        data: {
          paymentId: p.id,
          payloadHash: expectedPayloadHash,
          previousHash: GENESIS_HASH,
          chainHash: expectedChainHash,
        },
      });
    });

    it('links a subsequent row to the current chain tail, not genesis', async () => {
      mockTransactionPassthrough();
      const tailChainHash = 'a'.repeat(64);
      (prisma.paymentChecksum.findFirst as any).mockResolvedValue({
        id: 'checksum-0',
        sequence: 1,
        chainHash: tailChainHash,
      });
      (prisma.paymentChecksum.create as any).mockImplementation(async ({ data }: any) => ({
        id: 'checksum-2',
        sequence: 2,
        ...data,
      }));

      const p = payment({ id: 'payment-2', txHash: 'tx-hash-2' });
      const result = await appendPaymentChecksum(p);

      const expectedPayloadHash = computePayloadHash(p);
      const expectedChainHash = computeChainHash(tailChainHash, expectedPayloadHash);

      expect(result).toEqual({ chainHash: expectedChainHash });
      expect(prisma.paymentChecksum.create).toHaveBeenCalledWith({
        data: {
          paymentId: p.id,
          payloadHash: expectedPayloadHash,
          previousHash: tailChainHash,
          chainHash: expectedChainHash,
        },
      });
    });

    it('treats a duplicate append (P2002) as already-done and returns the existing row', async () => {
      const duplicateError: any = new Error('Unique constraint failed');
      duplicateError.code = 'P2002';
      (prisma.$transaction as any).mockRejectedValue(duplicateError);
      (prisma.paymentChecksum.findUnique as any).mockResolvedValue({
        id: 'checksum-1',
        chainHash: 'existing-chain-hash',
      });

      const result = await appendPaymentChecksum(payment());

      expect(result).toEqual({ chainHash: 'existing-chain-hash' });
      expect(prisma.paymentChecksum.findUnique).toHaveBeenCalledWith({ where: { paymentId: 'payment-1' } });
    });

    it('never throws — an unexpected transaction failure resolves to null instead of rejecting', async () => {
      (prisma.$transaction as any).mockRejectedValue(new Error('connection reset'));

      await expect(appendPaymentChecksum(payment())).resolves.toBeNull();
    });
  });

  describe('verifyChain', () => {
    it('validates a correctly-linked chain', async () => {
      const p1Payload = computePayloadHash(payment({ id: 'p1', txHash: 't1' }));
      const chain1 = computeChainHash(GENESIS_HASH, p1Payload);
      const p2Payload = computePayloadHash(payment({ id: 'p2', txHash: 't2' }));
      const chain2 = computeChainHash(chain1, p2Payload);

      (prisma.paymentChecksum.findMany as any).mockResolvedValue([
        { id: 'c1', sequence: 1, payloadHash: p1Payload, previousHash: GENESIS_HASH, chainHash: chain1 },
        { id: 'c2', sequence: 2, payloadHash: p2Payload, previousHash: chain1, chainHash: chain2 },
      ]);

      const result = await verifyChain();

      expect(result).toEqual({ valid: true, checkedCount: 2, brokenAtSequence: null, reason: null });
    });

    it('detects a tampered historical row (the entire point of a hash-pointer chain)', async () => {
      const p1Payload = computePayloadHash(payment({ id: 'p1', txHash: 't1' }));
      const chain1 = computeChainHash(GENESIS_HASH, p1Payload);
      const p2Payload = computePayloadHash(payment({ id: 'p2', txHash: 't2' }));
      const chain2 = computeChainHash(chain1, p2Payload);

      (prisma.paymentChecksum.findMany as any).mockResolvedValue([
        // Row 1's payloadHash has been altered after the fact (e.g. someone
        // edited the Payment row and the checksum wasn't recomputed) — its
        // stored chainHash no longer matches what recomputing it produces.
        { id: 'c1', sequence: 1, payloadHash: 'tampered'.repeat(8), previousHash: GENESIS_HASH, chainHash: chain1 },
        { id: 'c2', sequence: 2, payloadHash: p2Payload, previousHash: chain1, chainHash: chain2 },
      ]);

      const result = await verifyChain();

      expect(result.valid).toBe(false);
      expect(result.brokenAtSequence).toBe(1);
      expect(result.checkedCount).toBe(0);
    });

    it('detects a deleted historical row via the resulting previousHash mismatch', async () => {
      const p1Payload = computePayloadHash(payment({ id: 'p1', txHash: 't1' }));
      const chain1 = computeChainHash(GENESIS_HASH, p1Payload);
      const p2Payload = computePayloadHash(payment({ id: 'p2', txHash: 't2' }));
      const chain2 = computeChainHash(chain1, p2Payload);

      // Row 1 was deleted outright — row 2 is now the first row seen, but its
      // recorded previousHash still points at the (now-missing) chain1, not genesis.
      (prisma.paymentChecksum.findMany as any).mockResolvedValue([
        { id: 'c2', sequence: 2, payloadHash: p2Payload, previousHash: chain1, chainHash: chain2 },
      ]);

      const result = await verifyChain();

      expect(result.valid).toBe(false);
      expect(result.brokenAtSequence).toBe(2);
    });
  });

  describe('computeDailyMerkleRoot / verifyPaymentInDailyRoot', () => {
    it('computes the same root buildMerkleTree would produce directly, and stores it', async () => {
      const rows = [
        { id: 'c1', paymentId: 'p1', sequence: 1, payloadHash: computePayloadHash(payment({ id: 'p1', txHash: 't1' })), createdAt: new Date('2026-09-01T01:00:00.000Z') },
        { id: 'c2', paymentId: 'p2', sequence: 2, payloadHash: computePayloadHash(payment({ id: 'p2', txHash: 't2' })), createdAt: new Date('2026-09-01T02:00:00.000Z') },
        { id: 'c3', paymentId: 'p3', sequence: 3, payloadHash: computePayloadHash(payment({ id: 'p3', txHash: 't3' })), createdAt: new Date('2026-09-01T03:00:00.000Z') },
      ];
      (prisma.paymentChecksum.findMany as any).mockResolvedValue(rows);
      (prisma.dailyChecksumRoot.upsert as any).mockResolvedValue({});

      const expectedTree = buildMerkleTree(rows.map((r) => Buffer.from(r.payloadHash, 'hex')));

      const result = await computeDailyMerkleRoot(new Date('2026-09-01T12:00:00.000Z'));

      expect(result).toEqual({ date: '2026-09-01', merkleRoot: expectedTree.root, leafCount: 3 });
      expect(prisma.dailyChecksumRoot.upsert).toHaveBeenCalledWith({
        where: { date: '2026-09-01' },
        create: { date: '2026-09-01', merkleRoot: expectedTree.root, leafCount: 3 },
        update: expect.objectContaining({ merkleRoot: expectedTree.root, leafCount: 3 }),
      });
    });

    it('returns null for a day with no ingested payments (cannot build a tree from zero leaves)', async () => {
      (prisma.paymentChecksum.findMany as any).mockResolvedValue([]);

      const result = await computeDailyMerkleRoot(new Date('2026-09-02T12:00:00.000Z'));

      expect(result).toBeNull();
      expect(prisma.dailyChecksumRoot.upsert).not.toHaveBeenCalled();
    });

    it('verifies an individual payment is included in its day\'s stored Merkle root via a fresh inclusion proof', async () => {
      const rows = [
        { id: 'c1', paymentId: 'p1', sequence: 1, payloadHash: computePayloadHash(payment({ id: 'p1', txHash: 't1' })), createdAt: new Date('2026-09-01T01:00:00.000Z') },
        { id: 'c2', paymentId: 'p2', sequence: 2, payloadHash: computePayloadHash(payment({ id: 'p2', txHash: 't2' })), createdAt: new Date('2026-09-01T02:00:00.000Z') },
      ];
      const tree = buildMerkleTree(rows.map((r) => Buffer.from(r.payloadHash, 'hex')));

      (prisma.paymentChecksum.findUnique as any).mockResolvedValue(rows[1]);
      (prisma.dailyChecksumRoot.findUnique as any).mockResolvedValue({ date: '2026-09-01', merkleRoot: tree.root });
      (prisma.paymentChecksum.findMany as any).mockResolvedValue(rows);

      const isIncluded = await verifyPaymentInDailyRoot('p2', new Date('2026-09-01T12:00:00.000Z'));

      expect(isIncluded).toBe(true);
    });

    it('rejects inclusion against a root that does not actually commit to the payment', async () => {
      const rows = [
        { id: 'c1', paymentId: 'p1', sequence: 1, payloadHash: computePayloadHash(payment({ id: 'p1', txHash: 't1' })), createdAt: new Date('2026-09-01T01:00:00.000Z') },
      ];

      (prisma.paymentChecksum.findUnique as any).mockResolvedValue(rows[0]);
      // A root computed over a *different* set of leaves — not derived from `rows`.
      (prisma.dailyChecksumRoot.findUnique as any).mockResolvedValue({
        date: '2026-09-01',
        merkleRoot: hashMerkleLeaf(Buffer.from('unrelated-root', 'utf8')),
      });
      (prisma.paymentChecksum.findMany as any).mockResolvedValue(rows);

      const isIncluded = await verifyPaymentInDailyRoot('p1', new Date('2026-09-01T12:00:00.000Z'));

      expect(isIncluded).toBe(false);
    });
  });
});
