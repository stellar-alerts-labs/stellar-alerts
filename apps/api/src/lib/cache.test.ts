import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  get,
  set,
  del,
  getJson,
  setJson,
  getCachedOrFetch,
  clearMemoryCache,
  setRedisClientForTesting,
  getSacMetadataCacheKey,
  SAC_METADATA_TTL,
} from './cache';

describe('Cache Layer (Redis & Memory Fallback)', () => {
  beforeEach(() => {
    clearMemoryCache();
    setRedisClientForTesting(null);
  });

  afterEach(() => {
    clearMemoryCache();
    setRedisClientForTesting(null);
  });

  it('should generate correct SAC metadata cache key', () => {
    const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    expect(getSacMetadataCacheKey(contractId)).toBe(`sac:metadata:${contractId}`);
    expect(SAC_METADATA_TTL).toBe(86400);
  });

  describe('In-Memory Fallback Cache', () => {
    it('should store and retrieve string values', async () => {
      await set('test-key', 'test-value', 60);
      const val = await get('test-key');
      expect(val).toBe('test-value');
    });

    it('should return null for non-existent keys', async () => {
      const val = await get('missing-key');
      expect(val).toBeNull();
    });

    it('should delete keys properly', async () => {
      await set('to-delete', 'value', 60);
      expect(await get('to-delete')).toBe('value');
      await del('to-delete');
      expect(await get('to-delete')).toBeNull();
    });

    it('should store and retrieve JSON objects', async () => {
      const obj = { symbol: 'USDC', decimals: 6, name: 'USD Coin' };
      await setJson('sac:usdc', obj, 60);
      const retrieved = await getJson<typeof obj>('sac:usdc');
      expect(retrieved).toEqual(obj);
    });

    it('should handle expired in-memory items', async () => {
      await set('expire-key', 'expire-val', -1); // already expired
      const val = await get('expire-key');
      expect(val).toBeNull();
    });
  });

  describe('getCachedOrFetch Cache-Aside Helper', () => {
    it('should invoke fetcher on cache miss and cache the result', async () => {
      const fetcher = vi.fn().mockResolvedValue({ symbol: 'XLM', decimals: 7 });
      const result = await getCachedOrFetch('cache:miss:test', fetcher, 3600);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.cached).toBe(false);
      expect(result.data).toEqual({ symbol: 'XLM', decimals: 7 });

      // Second call should be a cache hit
      const hitResult = await getCachedOrFetch('cache:miss:test', fetcher, 3600);
      expect(fetcher).toHaveBeenCalledTimes(1); // not called again
      expect(hitResult.cached).toBe(true);
      expect(hitResult.data).toEqual({ symbol: 'XLM', decimals: 7 });
    });
  });

  describe('Redis Integration Mock', () => {
    it('should interact with Redis client when connected', async () => {
      const store = new Map<string, string>();
      const mockRedis: any = {
        status: 'ready',
        get: vi.fn(async (k: string) => store.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
          return 'OK';
        }),
        del: vi.fn(async (k: string) => {
          store.delete(k);
          return 1;
        }),
      };

      setRedisClientForTesting(mockRedis);

      await set('redis:key', 'redis:value', 86400);
      expect(mockRedis.set).toHaveBeenCalledWith('redis:key', 'redis:value', 'EX', 86400);

      const val = await get('redis:key');
      expect(mockRedis.get).toHaveBeenCalledWith('redis:key');
      expect(val).toBe('redis:value');

      await del('redis:key');
      expect(mockRedis.del).toHaveBeenCalledWith('redis:key');
    });
  });
});
