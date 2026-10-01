/**
 * Cursor pagination tests for payments — Issue #318
 *
 * Covers:
 *  - Service: cursor where-clause injection, limit+1 fetch, envelope shape
 *  - Service: invalid cursor propagates CursorError
 *  - Controller: cursor param wired through to service, CursorError → 400
 *  - Controller: response contains payments + pagination keys
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Prisma mock (must be hoisted before imports)
// ---------------------------------------------------------------------------
const { mockPayment } = vi.hoisted(() => ({
  mockPayment: { findMany: vi.fn(), aggregate: vi.fn() },
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    payment: mockPayment,
    sorobanEventSnapshot: { findMany: vi.fn() },
    sorobanContractSubscription: { findMany: vi.fn() },
  },
  prismaRead: {
    payment: mockPayment,
    sorobanEventSnapshot: { findMany: vi.fn() },
    sorobanContractSubscription: { findMany: vi.fn() },
  },
}));

import { PaymentsService, encodePaymentCursor, paymentsService } from '../payments.service';
import { PaymentsController } from '../payments.controller';
import { CursorError } from '../../../utils/pagination';

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------
function makePayment(id: string, receivedAt: Date) {
  return {
    id,
    walletId: 'w-1',
    txHash: `hash-${id}`,
    fromAddress: 'GABC',
    amount: { toString: () => '10.0' } as any,
    asset: 'XLM',
    assetIssuer: null,
    memo: null,
    receivedAt,
    createdAt: receivedAt,
  };
}

// ---------------------------------------------------------------------------
// PaymentsService — cursor behaviour
// ---------------------------------------------------------------------------

describe('PaymentsService cursor pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns {items, pagination} envelope on the first page (no cursor)', async () => {
    mockPayment.findMany.mockResolvedValue([]);

    const result = await paymentsService.getPayments('user-1');

    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('pagination');
    expect(result.pagination).toMatchObject({ limit: 20, hasNextPage: false });
    expect(result.pagination.nextCursor).toBeUndefined();
  });

  it('fetches limit+1 rows to detect the next page', async () => {
    mockPayment.findMany.mockResolvedValue([]);

    await paymentsService.getPayments('user-1', undefined, 10);

    expect(mockPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11 }),
    );
  });

  it('sets hasNextPage=true and provides nextCursor when extra row exists', async () => {
    // Simulate 6 rows returned for limit=5
    const rows = Array.from({ length: 6 }, (_, i) =>
      makePayment(`id-${i}`, new Date(2026, 0, i + 1)),
    );
    mockPayment.findMany.mockResolvedValue(rows);

    const result = await paymentsService.getPayments('user-1', undefined, 5);

    expect(result.items).toHaveLength(5);
    expect(result.pagination.hasNextPage).toBe(true);
    expect(result.pagination.nextCursor).toBeDefined();
  });

  it('nextCursor encodes the last visible item (not the overflow row)', async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makePayment(`id-${i}`, new Date(2026, 0, i + 1)),
    );
    mockPayment.findMany.mockResolvedValue(rows);

    const result = await paymentsService.getPayments('user-1', undefined, 5);

    // Decode the cursor — it must reference id-4 (5th item, 0-indexed)
    const expectedCursor = encodePaymentCursor(rows[4]);
    expect(result.pagination.nextCursor).toBe(expectedCursor);
  });

  it('injects cursor OR-clause into the where when cursor is provided', async () => {
    mockPayment.findMany.mockResolvedValue([]);
    const cursorItem = makePayment('cl-anchor', new Date('2026-05-01T00:00:00.000Z'));
    const cursor = encodePaymentCursor(cursorItem);

    await paymentsService.getPayments('user-1', undefined, 20, { cursor });

    const call = mockPayment.findMany.mock.calls[0][0];
    // The where must contain an OR with a receivedAt lt condition
    const whereStr = JSON.stringify(call.where);
    expect(whereStr).toContain('"lt"');
    expect(whereStr).toContain('cl-anchor');
  });

  it('throws CursorError for a malformed cursor string', async () => {
    await expect(
      paymentsService.getPayments('user-1', undefined, 20, { cursor: 'totally-invalid' }),
    ).rejects.toThrow(CursorError);
  });

  it('orderBy always includes id as tiebreaker', async () => {
    mockPayment.findMany.mockResolvedValue([]);

    await paymentsService.getPayments('user-1');

    const call = mockPayment.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
    );
  });
});

// ---------------------------------------------------------------------------
// PaymentsController — cursor wiring
// ---------------------------------------------------------------------------

describe('PaymentsController cursor pagination', () => {
  let controller: PaymentsController;
  let mockReply: any;

  beforeEach(() => {
    controller = new PaymentsController();
    vi.clearAllMocks();
    mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
  });

  it('passes cursor query param to the service', async () => {
    const fakeCursor = encodePaymentCursor({
      id: 'cl-test',
      receivedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const getPaymentsSpy = vi.spyOn(paymentsService, 'getPayments').mockResolvedValue({
      items: [],
      pagination: { limit: 20, hasNextPage: false },
    } as any);

    await controller.getPayments(
      { query: { cursor: fakeCursor }, user: { id: 'user-1' } } as any,
      mockReply,
    );

    expect(getPaymentsSpy).toHaveBeenCalledWith(
      'user-1',
      undefined,
      20,
      expect.objectContaining({ cursor: fakeCursor }),
    );
  });

  it('response includes both payments and pagination keys', async () => {
    const getPaymentsSpy = vi.spyOn(paymentsService, 'getPayments').mockResolvedValue({
      items: [],
      pagination: { limit: 20, hasNextPage: false },
    } as any);

    await controller.getPayments(
      { query: {}, user: { id: 'user-1' } } as any,
      mockReply,
    );

    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        payments: [],
        pagination: expect.objectContaining({ limit: 20, hasNextPage: false }),
      }),
    );
  });

  it('returns 400 when service throws CursorError', async () => {
    const getPaymentsSpy = vi.spyOn(paymentsService, 'getPayments').mockRejectedValue(new CursorError());

    await controller.getPayments(
      { query: { cursor: 'bad' }, user: { id: 'user-1' } } as any,
      mockReply,
    );

    expect(mockReply.status).toHaveBeenCalledWith(400);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Invalid cursor' }),
    );
  });

  it('rejects limit > 100 with 400', async () => {
    await controller.getPayments(
      { query: { limit: '200' }, user: { id: 'user-1' } } as any,
      mockReply,
    );

    expect(mockReply.status).toHaveBeenCalledWith(400);
  });

  it('rejects limit = 0 with 400', async () => {
    await controller.getPayments(
      { query: { limit: '0' }, user: { id: 'user-1' } } as any,
      mockReply,
    );

    expect(mockReply.status).toHaveBeenCalledWith(400);
  });
});
