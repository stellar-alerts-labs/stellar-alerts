import Redis, { RedisOptions } from 'ioredis';

export const SAC_METADATA_TTL = 86400; // 24 hours in seconds

export function getSacMetadataCacheKey(contractId: string): string {
  return `sac:metadata:${contractId}`;
}

interface MemoryCacheEntry {
  value: string;
  expiresAt: number;
}

// In-memory fallback map for offline resilience / testing
const memoryCache = new Map<string, MemoryCacheEntry>();

let redisClient: Redis | null = null;
let isRedisReady = false;

function createRedisClient(): Redis | null {
  try {
    const redisUrl = process.env.REDIS_URL;
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);

    const options: RedisOptions = {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      retryStrategy: (times: number) => {
        if (times > 3) return null; // stop reconnecting after 3 tries in background
        return Math.min(times * 500, 2000);
      },
    };

    const client = redisUrl ? new Redis(redisUrl, options) : new Redis({ host, port, ...options });

    client.on('connect', () => {
      isRedisReady = true;
      console.log('[Cache] 🟢 Connected to Redis');
    });

    client.on('ready', () => {
      isRedisReady = true;
    });

    client.on('error', (err: any) => {
      isRedisReady = false;
      // Log connection error once/warn without crashing process
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[Cache] ⚠️ Redis connection error: ${err.message}`);
      }
    });

    client.on('close', () => {
      isRedisReady = false;
    });

    // Attempt initial connection asynchronously
    client.connect().catch((err) => {
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[Cache] ⚠️ Initial Redis connection failed (${err.message}). Using memory fallback.`);
      }
    });

    return client;
  } catch (err: any) {
    console.warn(`[Cache] ⚠️ Could not initialize Redis client: ${err.message}`);
    return null;
  }
}

// Initialize Redis client
redisClient = createRedisClient();

export function getRedisClient(): Redis | null {
  return redisClient;
}

export function setRedisClientForTesting(mockClient: Redis | null) {
  redisClient = mockClient;
  isRedisReady = !!mockClient;
}

export function isConnected(): boolean {
  return isRedisReady && redisClient?.status === 'ready';
}

/**
 * Retrieves a string value from cache (Redis or in-memory fallback).
 */
export async function get(key: string): Promise<string | null> {
  if (redisClient && isRedisReady) {
    try {
      const val = await redisClient.get(key);
      if (val !== null) {
        return val;
      }
    } catch (err: any) {
      // Fallback to memory cache on redis failure
    }
  }

  // In-memory fallback check
  const memEntry = memoryCache.get(key);
  if (memEntry) {
    if (Date.now() > memEntry.expiresAt) {
      memoryCache.delete(key);
      return null;
    }
    return memEntry.value;
  }

  return null;
}

/**
 * Sets a string value in cache with optional TTL in seconds.
 */
export async function set(key: string, value: string, ttlSeconds: number = SAC_METADATA_TTL): Promise<void> {
  // Always update memory fallback
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });

  if (redisClient && isRedisReady) {
    try {
      if (ttlSeconds > 0) {
        await redisClient.set(key, value, 'EX', ttlSeconds);
      } else {
        await redisClient.set(key, value);
      }
    } catch (err: any) {
      // Memory cache is already updated
    }
  }
}

/**
 * Deletes a key from cache.
 */
export async function del(key: string): Promise<void> {
  memoryCache.delete(key);

  if (redisClient && isRedisReady) {
    try {
      await redisClient.del(key);
    } catch (err: any) {
      // Handled
    }
  }
}

/**
 * Retrieves and deserializes a JSON value from cache.
 */
export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Serializes and sets a JSON value in cache with TTL in seconds.
 */
export async function setJson<T>(key: string, value: T, ttlSeconds: number = SAC_METADATA_TTL): Promise<void> {
  const raw = JSON.stringify(value);
  await set(key, raw, ttlSeconds);
}

/**
 * Cache-aside pattern helper: retrieves from cache or invokes fetcher and caches the result.
 */
export async function getCachedOrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number = SAC_METADATA_TTL
): Promise<{ data: T; cached: boolean }> {
  const cached = await getJson<T>(key);
  if (cached !== null) {
    return { data: cached, cached: true };
  }

  const fresh = await fetcher();
  if (fresh !== undefined && fresh !== null) {
    await setJson(key, fresh, ttlSeconds);
  }
  return { data: fresh, cached: false };
}

/**
 * Clears the in-memory fallback cache (mainly for testing).
 */
export function clearMemoryCache(): void {
  memoryCache.clear();
}

/**
 * Closes the Redis connection gracefully.
 */
export async function closeCache(): Promise<void> {
  clearMemoryCache();
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      redisClient.disconnect();
    }
    isRedisReady = false;
  }
}
