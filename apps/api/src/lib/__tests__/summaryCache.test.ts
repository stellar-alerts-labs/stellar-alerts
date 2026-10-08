import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, mockRedis, getRedisStatusMock } = vi.hoisted(() => {
  const store = new Map<string, string>();

  const mockRedis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _mode?: string, _ttl?: number) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n++;
      }
      return n;
    }),
    // ioredis: scan(cursor, 'MATCH', pattern, 'COUNT', count)
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const keys = [...store.keys()].filter((k) => {
        // Convert Redis SCAN pattern to regex
        // * matches any sequence of characters
        const regexPattern = pattern
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        const re = new RegExp('^' + regexPattern + '$');
        return re.test(k);
      });
      return ['0', keys];
    }),
  };

  return {
    store,
    mockRedis,
    getRedisStatusMock: vi.fn(() => 'ready' as const),
  };
});

vi.mock('../redis', () => ({
  redis: mockRedis,
  getRedisStatus: getRedisStatusMock,
}));

import {
  SUMMARY_CACHE_VERSION,
  buildSummaryCacheKey,
  getCachedSummary,
  setCachedSummary,
  invalidateUserSummaryCache,
  withSummaryCache,
} from '../summaryCache';

describe('summaryCache (#285)', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    getRedisStatusMock.mockReturnValue('ready');
  });

  it('primary: builds versioned keys including user and optional wallet/fiat', () => {
    expect(
      buildSummaryCacheKey({
        kind: 'payments',
        userId: 'u1',
        walletId: 'w1',
        fiat: 'NGN',
      }),
    ).toBe(
      `summary:${SUMMARY_CACHE_VERSION}:payments:user:u1:wallet:w1:fiat:ngn`,
    );
  });

  it('primary: cache hit returns payload without calling loader twice', async () => {
    const load = vi.fn(async () => ({ totalPayments: 3 }));
    const first = await withSummaryCache({
      kind: 'payments',
      userId: 'u1',
      load,
      redisClient: mockRedis as any,
    });
    expect(first.meta.cacheHit).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);

    const second = await withSummaryCache({
      kind: 'payments',
      userId: 'u1',
      load,
      redisClient: mockRedis as any,
    });
    expect(second.meta.cacheHit).toBe(true);
    expect(second.value).toEqual({ totalPayments: 3 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('boundary: invalidation removes all user summary keys', async () => {
    await setCachedSummary(
      buildSummaryCacheKey({ kind: 'payments', userId: 'u1' }),
      { a: 1 },
      60,
      mockRedis as any,
    );
    await setCachedSummary(
      buildSummaryCacheKey({ kind: 'delivery', userId: 'u1' }),
      { b: 2 },
      60,
      mockRedis as any,
    );
    await setCachedSummary(
      buildSummaryCacheKey({ kind: 'payments', userId: 'u2' }),
      { c: 3 },
      60,
      mockRedis as any,
    );

    const deleted = await invalidateUserSummaryCache('u1', mockRedis as any);
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(
      await getCachedSummary(
        buildSummaryCacheKey({ kind: 'payments', userId: 'u1' }),
        mockRedis as any,
      ),
    ).toBeNull();
    expect(
      await getCachedSummary(
        buildSummaryCacheKey({ kind: 'payments', userId: 'u2' }),
        mockRedis as any,
      ),
    ).not.toBeNull();
  });

  it('failure: Redis get errors bypass cache and still load primary', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('redis down'));
    const load = vi.fn(async () => ({ ok: true }));
    const result = await withSummaryCache({
      kind: 'payments',
      userId: 'u1',
      load,
      redisClient: mockRedis as any,
    });
    expect(result.value).toEqual({ ok: true });
    expect(result.meta.source).toBe('primary');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
