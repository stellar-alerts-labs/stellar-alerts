import type Redis from 'ioredis';
import { redis, getRedisStatus } from './redis';

/** Bump when summary JSON shape changes (invalidates all old keys). */
export const SUMMARY_CACHE_VERSION = 'v1';

/** Default TTL for dashboard summary payloads (seconds). */
export const SUMMARY_CACHE_TTL_SECONDS = Number(
  process.env.SUMMARY_CACHE_TTL_SECONDS || 60,
);

/** Soft max TTL clamp (seconds) — never cache longer than this. */
export const SUMMARY_CACHE_TTL_MAX_SECONDS = 300;

export type SummaryKind = 'payments' | 'delivery' | 'cross_ledger';

export interface SummaryCacheMeta {
  cacheHit: boolean;
  stalePossible: boolean;
  source: 'redis' | 'primary' | 'bypass';
  /** ISO time when the cached value was written (if known). */
  cachedAt?: string;
  ttlSeconds?: number;
}

export interface CachedSummaryEnvelope<T> {
  data: T;
  cachedAt: string;
  version: string;
}

function clampTtl(ttlSeconds: number): number {
  const n = Number.isFinite(ttlSeconds) ? ttlSeconds : SUMMARY_CACHE_TTL_SECONDS;
  return Math.max(1, Math.min(SUMMARY_CACHE_TTL_MAX_SECONDS, Math.floor(n)));
}

/**
 * Versioned Redis key for dashboard aggregates.
 * Shape: summary:{version}:{kind}:user:{userId}[:wallet:{walletId}][:fiat:{code}]
 */
export function buildSummaryCacheKey(params: {
  kind: SummaryKind;
  userId: string;
  walletId?: string | null;
  fiat?: string | null;
}): string {
  const parts = [
    'summary',
    SUMMARY_CACHE_VERSION,
    params.kind,
    `user:${params.userId}`,
  ];
  if (params.walletId) parts.push(`wallet:${params.walletId}`);
  if (params.fiat) parts.push(`fiat:${params.fiat.toLowerCase()}`);
  return parts.join(':');
}

/** Pattern used to invalidate all summary keys for a user (any kind / wallet / fiat). */
export function buildSummaryUserPattern(userId: string): string {
  return `summary:${SUMMARY_CACHE_VERSION}:*:user:${userId}*`;
}

function isRedisUsable(): boolean {
  const status = getRedisStatus();
  return status === 'ready' || status === 'connecting';
}

/**
 * Read a cached summary. On Redis errors returns null (caller loads primary).
 * Cache failure never throws to the request path.
 */
export async function getCachedSummary<T>(
  key: string,
  redisClient: Redis = redis,
): Promise<CachedSummaryEnvelope<T> | null> {
  if (!isRedisUsable()) return null;
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSummaryEnvelope<T>;
    if (!parsed || parsed.version !== SUMMARY_CACHE_VERSION || parsed.data === undefined) {
      return null;
    }
    return parsed;
  } catch (error: any) {
    console.warn(`[SummaryCache] get failed for ${key}: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * Write summary with bounded TTL. Failures are logged only.
 */
export async function setCachedSummary<T>(
  key: string,
  data: T,
  ttlSeconds: number = SUMMARY_CACHE_TTL_SECONDS,
  redisClient: Redis = redis,
): Promise<boolean> {
  if (!isRedisUsable()) return false;
  const ttl = clampTtl(ttlSeconds);
  const envelope: CachedSummaryEnvelope<T> = {
    data,
    cachedAt: new Date().toISOString(),
    version: SUMMARY_CACHE_VERSION,
  };
  try {
    await redisClient.set(key, JSON.stringify(envelope), 'EX', ttl);
    return true;
  } catch (error: any) {
    console.warn(`[SummaryCache] set failed for ${key}: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * Invalidate all versioned summary keys for a user (payment + delivery + cross_ledger).
 * Uses SCAN so we do not block Redis with KEYS.
 */
export async function invalidateUserSummaryCache(
  userId: string,
  redisClient: Redis = redis,
): Promise<number> {
  if (!userId) return 0;
  if (!isRedisUsable()) return 0;

  const pattern = buildSummaryUserPattern(userId);
  let deleted = 0;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        deleted += await redisClient.del(...keys);
      }
    } while (cursor !== '0');
  } catch (error: any) {
    console.warn(
      `[SummaryCache] invalidate failed for user ${userId}: ${error?.message ?? error}`,
    );
  }
  return deleted;
}

/**
 * Cache-aside helper: try Redis → on miss/error run primary loader → best-effort fill.
 * Primary path always runs if cache misses or Redis is down.
 */
export async function withSummaryCache<T>(options: {
  kind: SummaryKind;
  userId: string;
  walletId?: string | null;
  fiat?: string | null;
  ttlSeconds?: number;
  /** When true, skip Redis entirely (tests / force refresh). */
  bypass?: boolean;
  load: () => Promise<T>;
  redisClient?: Redis;
}): Promise<{ value: T; meta: SummaryCacheMeta }> {
  const ttl = clampTtl(options.ttlSeconds ?? SUMMARY_CACHE_TTL_SECONDS);
  const key = buildSummaryCacheKey({
    kind: options.kind,
    userId: options.userId,
    walletId: options.walletId,
    fiat: options.fiat,
  });
  const client = options.redisClient ?? redis;

  if (options.bypass) {
    const value = await options.load();
    return {
      value,
      meta: { cacheHit: false, stalePossible: false, source: 'bypass' },
    };
  }

  const cached = await getCachedSummary<T>(key, client);
  if (cached) {
    return {
      value: cached.data,
      meta: {
        cacheHit: true,
        stalePossible: true,
        source: 'redis',
        cachedAt: cached.cachedAt,
        ttlSeconds: ttl,
      },
    };
  }

  const value = await options.load();
  await setCachedSummary(key, value, ttl, client);
  return {
    value,
    meta: {
      cacheHit: false,
      stalePossible: false,
      source: 'primary',
      ttlSeconds: ttl,
    },
  };
}
