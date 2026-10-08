import { describe, it, expect, beforeEach, vi } from 'vitest';
import { accountService } from '../account.service';

// ── Prisma mock ────────────────────────────────────────────────────────────
// Pattern matches the rest of the test suite in this repo.

vi.mock('../../../lib/prisma', () => {
  const makeUser = (id: string) => ({
    id,
    email: `${id}@example.com`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    wallets: [
      {
        id: `wlt-${id}`,
        publicKey: `GABC${id.toUpperCase()}`,
        label: 'Test wallet',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        cursor: null,
        payments: [
          {
            id: `pay-${id}-1`,
            txHash: `hash-${id}-1`,
            fromAddress: 'GSENDER',
            amount: 100,
            asset: 'XLM',
            assetIssuer: null,
            memo: null,
            receivedAt: new Date('2026-06-01T00:00:00Z'),
          },
        ],
      },
    ],
    webhooks: [
      {
        id: `wh-${id}`,
        url: 'https://example.com/hook',
        isActive: true,
        createdAt: new Date('2026-01-03T00:00:00Z'),
        logs: [],
        circuitBreaker: null,
      },
    ],
    notifyPrefs: {
      id: `pref-${id}`,
      userId: id,
      emailEnabled: true,
      telegramEnabled: false,
      telegramChatId: null,
      whatsappEnabled: false,
      whatsappNumber: null,
      language: 'EN',
      filterRules: null,
    },
    sorobanSubscriptions: [],
    multisigSignerWatches: [],
    anchorWatches: [],
    dexSwapWatches: [],
  });

  return {
    prisma: {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          if (where.id === 'known-user') return makeUser('known-user');
          return null;
        }),
        delete: vi.fn(async () => ({ id: 'known-user' })),
      },
      webhook: {
        findMany: vi.fn(async () => [{ id: 'wh-known-user' }]),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      webhookLog: {
        deleteMany: vi.fn(async () => ({ count: 2 })),
      },
      webhookCircuitBreaker: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      wallet: {
        findMany: vi.fn(async () => [{ id: 'wlt-known-user' }]),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      payment: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      ingestionCursor: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      notificationPreference: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      sorobanContractSubscription: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      multisigSignerWatcher: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      anchorTransactionWatch: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      dexSwapWatch: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      $transaction: vi.fn(async (fn: Function) => {
        // Provide a tx proxy that delegates to the top-level mocks above.
        const { prisma: p } = await import('../../../lib/prisma');
        return fn(p);
      }),
    },
  };
});

describe('AccountService.exportAccount', () => {
  it('returns structured export data for a known user', async () => {
    const result = await accountService.exportAccount('known-user');

    expect(result.user.id).toBe('known-user');
    expect(result.user.email).toBe('known-user@example.com');
    expect(result.wallets).toHaveLength(1);
    expect(result.wallets[0].payments).toHaveLength(1);
    expect(result.wallets[0].payments[0].txHash).toBe('hash-known-user-1');
    expect(result.notificationPreferences).not.toBeNull();
    expect(result.paymentsCsv).toContain('Date');       // CSV header row
    expect(result.paymentsCsv).toContain('hash-known-user-1');
    expect(result.exportedAt).toBeDefined();
  });

  it('throws "User not found" for an unknown user id', async () => {
    await expect(accountService.exportAccount('ghost-user')).rejects.toThrow('User not found');
  });

  it('includes CSV with correct columns', async () => {
    const result = await accountService.exportAccount('known-user');
    const [header] = result.paymentsCsv.split('\n');
    expect(header).toContain('Date');
    expect(header).toContain('Transaction Hash');
    expect(header).toContain('From Address');
    expect(header).toContain('Amount');
    expect(header).toContain('Asset');
  });
});

describe('AccountService.deleteAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a deletion summary with counts', async () => {
    const summary = await accountService.deleteAccount('known-user');

    expect(summary.userId).toBe('known-user');
    expect(summary.deletedAt).toBeDefined();
    expect(summary.counts.users).toBe(1);
    expect(summary.counts.webhookLogs).toBeGreaterThanOrEqual(0);
    expect(summary.counts.wallets).toBeGreaterThanOrEqual(0);
  });

  it('summary includes all expected entity keys', async () => {
    const summary = await accountService.deleteAccount('known-user');
    const expectedKeys = [
      'webhookLogs',
      'webhookCircuitBreakers',
      'webhooks',
      'payments',
      'ingestionCursors',
      'wallets',
      'notificationPreferences',
      'sorobanSubscriptions',
      'multisigWatches',
      'anchorWatches',
      'dexSwapWatches',
      'users',
    ];
    for (const key of expectedKeys) {
      expect(summary.counts).toHaveProperty(key);
    }
  });
});
