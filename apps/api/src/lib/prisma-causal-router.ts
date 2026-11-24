/**
 * Read-your-own-writes (RYOW) routing for a primary/replica PostgreSQL setup.
 *
 * A mutation on the primary is not visible on a streaming replica until the
 * replica has replayed the WAL record. This module records the primary LSN
 * reached by a user's mutation in Redis (`ryow:{userId}`, 10s TTL) and, on a
 * subsequent read for that user, compares the replica's replay LSN with the
 * watermark. Reads with no watermark keep using the replica and do not issue
 * an extra LSN query.
 *
 * All external effects (watermark store, primary/replica LSN probes) are
 * injectable so routing behaviour can be unit tested without PostgreSQL or
 * Redis.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { redisCache } from './redis';

/** How long a mutation watermark stays relevant. */
export const RYOW_WATERMARK_TTL_SECONDS = 10;

export interface CausalContext {
  userId: string;
  tenantId?: string;
}

const contextStorage = new AsyncLocalStorage<CausalContext>();

/** Returns the causal context bound to the current async execution. */
export function getCausalContext(): CausalContext | undefined {
  return contextStorage.getStore();
}

/** Binds a context to the current request/handler without creating a new async scope. */
export function enterCausalContext(context: CausalContext): void {
  contextStorage.enterWith(context);
}

/** Runs `fn` with an explicit causal context. Preferred for worker jobs and tests. */
export async function withCausalContext<T>(
  context: CausalContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  return contextStorage.run(context, fn);
}

const LSN_PATTERN = /^([0-9a-f]{1,8})\/([0-9a-f]{1,8})$/i;

export interface ParsedLsn {
  log: bigint;
  offset: bigint;
}

/**
 * Parses a PostgreSQL LSN such as `0/16B3748` into its two 32-bit words.
 * Throws on malformed values so callers can fail closed (route to primary)
 * rather than silently treating a bad watermark as "replica is caught up".
 */
export function parseLsn(value: string): ParsedLsn {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid LSN: expected a string, got ${typeof value}`);
  }
  const match = LSN_PATTERN.exec(value.trim());
  if (!match) {
    throw new TypeError(`Invalid LSN: "${value}" (expected log/offset hex words)`);
  }
  return {
    log: BigInt(`0x${match[1]}`),
    offset: BigInt(`0x${match[2]}`),
  };
}

/**
 * Pure comparison of two PostgreSQL LSNs. Returns -1 when `a < b`, 0 when
 * equal, and 1 when `a > b`. Both words are compared numerically, so
 * `0/16B3748 > 0/16B3700` and `1/0 > 0/FFFFFFFF`.
 */
export function compareLsn(a: string, b: string): -1 | 0 | 1 {
  const left = parseLsn(a);
  const right = parseLsn(b);
  if (left.log !== right.log) return left.log < right.log ? -1 : 1;
  if (left.offset !== right.offset) return left.offset < right.offset ? -1 : 1;
  return 0;
}

export interface WatermarkStore {
  get(userId: string): Promise<string | null>;
  set(userId: string, lsn: string, ttlSeconds: number): Promise<void>;
}

export interface LsnProbes {
  getPrimaryLsn(): Promise<string>;
  getReplicaLsn(): Promise<string>;
}

export interface CausalRouterDeps extends WatermarkStore, LsnProbes {}

export function watermarkKey(userId: string): string {
  return `ryow:${userId}`;
}

/** Redis-backed watermark store used by the running API. */
export const redisWatermarkStore: WatermarkStore = {
  async get(userId) {
    return redisCache.get(watermarkKey(userId));
  },
  async set(userId, lsn, ttlSeconds) {
    // Never let a delayed mutation overwrite a newer watermark with an older
    // LSN: replicas only move forward, so the maximum is the safe value.
    const existing = await redisCache.get(watermarkKey(userId));
    if (existing) {
      try {
        if (compareLsn(existing, lsn) >= 0) return;
      } catch {
        // A malformed stored value must not block a fresh, valid watermark.
      }
    }
    await redisCache.set(watermarkKey(userId), lsn, ttlSeconds);
  },
};

/**
 * Simple deterministic store for tests and degraded-mode callers. Expiry uses
 * the injected clock so tests can advance time without sleeping.
 */
export function createMemoryWatermarkStore(
  now: () => number = Date.now,
): WatermarkStore & { clear(): void } {
  const entries = new Map<string, { lsn: string; expiresAt: number }>();
  return {
    async get(userId) {
      const entry = entries.get(userId);
      if (!entry) return null;
      if (now() >= entry.expiresAt) {
        entries.delete(userId);
        return null;
      }
      return entry.lsn;
    },
    async set(userId, lsn, ttlSeconds) {
      entries.set(userId, { lsn, expiresAt: now() + ttlSeconds * 1000 });
    },
    clear() {
      entries.clear();
    },
  };
}

export type ReadTarget = 'PRIMARY' | 'REPLICA';

export class CausalRouter {
  constructor(
    private readonly deps: CausalRouterDeps,
    private readonly ttlSeconds: number = RYOW_WATERMARK_TTL_SECONDS,
  ) {}

  /** Records the primary LSN reached by a mutation for a user/tenant. */
  async recordMutation(userId: string, _tenantId?: string): Promise<string> {
    const lsn = await this.deps.getPrimaryLsn();
    await this.deps.set(userId, lsn, this.ttlSeconds);
    return lsn;
  }

  /** Returns the current watermark, or null when there is none. */
  async getWatermark(userId: string): Promise<string | null> {
    return this.deps.get(userId);
  }

  /**
   * Chooses the read target for a user. A user without a watermark goes
   * straight to the replica without any LSN query. A user with a watermark
   * pays one replay-LSN query; if the value is malformed or the probe fails,
   * the read goes to the primary (fail closed for consistency).
   */
  async resolveReadTarget(userId: string): Promise<ReadTarget> {
    const watermark = await this.deps.get(userId);
    if (!watermark) return 'REPLICA';

    try {
      const replayLsn = await this.deps.getReplicaLsn();
      return compareLsn(replayLsn, watermark) >= 0 ? 'REPLICA' : 'PRIMARY';
    } catch {
      return 'PRIMARY';
    }
  }
}

/** Set of Prisma delegate methods that mutate state. */
export const MUTATION_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Set of Prisma delegate methods that are safe to serve from a replica. */
export const READ_OPERATIONS = new Set([
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

export interface CausalClients<T> {
  primary: T;
  replica: T;
}

/**
 * Wraps a Prisma client so reads on read-heavy models are routed per call
 * according to the user's watermark. The proxy itself is synchronous; the
 * routing decision (Redis GET, then optional replay-LSN query) happens inside
 * each read call, which is already asynchronous.
 */
export function createCausalReadProxy<T extends object>(
  userId: string,
  clients: CausalClients<T>,
  router: CausalRouter,
): T {
  return new Proxy(clients.replica, {
    get(replica, property, receiver) {
      const replicaValue = Reflect.get(replica, property, receiver);

      // Model delegates (e.g. `payment`, `wallet`) expose read methods.
      if (replicaValue && typeof replicaValue === 'object') {
        return new Proxy(replicaValue as object, {
          get(delegate, method, delegateReceiver) {
            const value = Reflect.get(delegate, method, delegateReceiver);
            if (typeof value !== 'function' || !READ_OPERATIONS.has(String(method))) {
              return typeof value === 'function' ? value.bind(delegate) : value;
            }
            return async (...args: unknown[]) => {
              const target =
                (await router.resolveReadTarget(userId)) === 'PRIMARY'
                  ? (clients.primary as Record<string | symbol, any>)[property as string | symbol]
                  : delegate;
              return (target as Record<string | symbol, (...args: unknown[]) => unknown>)[
                method as string | symbol
              ](...args);
            };
          },
        });
      }

      return typeof replicaValue === 'function' ? replicaValue.bind(replica) : replicaValue;
    },
  }) as T;
}

let router: CausalRouter | null = null;

/**
 * Installs the live router. `prisma.ts` owns the LSN probes because they need
 * to follow primary promotion; the watermark store defaults to Redis.
 */
export function configureCausalRouter(
  probes: Partial<LsnProbes> = {},
  options: { store?: WatermarkStore; ttlSeconds?: number } = {},
): CausalRouter {
  let fallbackProbe: LsnProbes = {
    getPrimaryLsn: async () => {
      throw new Error('Primary LSN probe is not configured');
    },
    getReplicaLsn: async () => {
      throw new Error('Replica LSN probe is not configured');
    },
  };
  router = new CausalRouter(
    {
      get: (userId) => (options.store ?? redisWatermarkStore).get(userId),
      set: (userId, lsn, ttl) => (options.store ?? redisWatermarkStore).set(userId, lsn, ttl),
      getPrimaryLsn: () => (probes.getPrimaryLsn ?? fallbackProbe.getPrimaryLsn)(),
      getReplicaLsn: () => (probes.getReplicaLsn ?? fallbackProbe.getReplicaLsn)(),
    },
    options.ttlSeconds,
  );
  return router;
}

/** Returns the singleton router, configuring a fail-closed one on first use. */
export function getCausalRouter(): CausalRouter {
  return (router ??= configureCausalRouter());
}

/**
 * Records a mutation for the context bound to the current async execution.
 * A missing context means a system/internal write, which has no user-specific
 * visibility requirement.
 */
export async function recordMutationForContext(): Promise<void> {
  const context = getCausalContext();
  if (!context?.userId) return;
  await getCausalRouter().recordMutation(context.userId, context.tenantId);
}
