import { PrismaClient } from '../../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';
import { resolvePoolConfig } from './db-pool';

function createClient(databaseUrl: string, label: string) {
  const config = resolvePoolConfig(databaseUrl);
  console.log(
    `[Prisma] ${label} pool: max=${config.max} connections, acquire timeout=${config.connectionTimeoutMillis}ms, idle timeout=${config.idleTimeoutMillis}ms`
  );

  return new PrismaClient({ adapter: new PrismaPg(config) });
}

const primaryUrl = env.DATABASE_URL || process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/stellar_alerts';
const replicaUrl = env.READ_REPLICA_URL || process.env.READ_REPLICA_URL;

let primaryClient = createClient(primaryUrl, 'primary');

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const value = (primaryClient as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(primaryClient);
    }
    return value;
  },
});

/**
 * Client for read-only queries. Points at READ_REPLICA_URL when a read
 * replica is configured and falls back to the primary otherwise, so callers can
 * use it unconditionally.
 */
export const prismaRead = replicaUrl ? createClient(replicaUrl, 'replica') : prisma;
export const replicaPrisma = prismaRead;

export type DatabaseTarget = 'PRIMARY' | 'REPLICA';

export let activeReadTarget: DatabaseTarget = 'REPLICA';

export function setReadTarget(target: DatabaseTarget): void {
  activeReadTarget = target;
  console.log(`[DB Pool Engine] 🔀 Read traffic target updated to: ${target}`);
}

export function getReadTarget(): DatabaseTarget {
  return activeReadTarget;
}

export function getReadClient() {
  return activeReadTarget === 'PRIMARY' ? prisma : prismaRead;
}

export async function switchDatabaseUrl(newUrl: string): Promise<void> {
  console.log(`[Prisma] Switching database URL to: ${newUrl}`);
  process.env.DATABASE_URL = newUrl;
  setReadTarget('PRIMARY');

  try {
    await primaryClient.$disconnect();
  } catch {
    // Pool may not be connected during DR drills or unit tests.
  }

  primaryClient = createClient(newUrl, 'primary-promoted');

  if (process.env.VITEST !== 'true') {
    await primaryClient.$connect();
  }
}

export const DEFAULT_DB_MAX_RETRIES = 5;
export const DEFAULT_DB_BASE_DELAY_MS = 1000;
export const DEFAULT_DB_MAX_DELAY_MS = 16000;

export interface DbConnectionRetryOptions {
  /** Total connection attempts before giving up (default: 5). */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds (default: 1000ms). */
  baseDelayMs?: number;
  /** Maximum backoff delay cap in milliseconds (default: 16000ms). */
  maxDelayMs?: number;
  /** Fractional random jitter [0..1] applied to each delay (default: 0.2). */
  jitterRatio?: number;
  /** Optional Prisma-compatible client override for testing. */
  client?: { $connect: () => Promise<void> };
  /** Optional sleep override for fast deterministic unit tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional random number generator [0, 1) for deterministic jitter tests. */
  random?: () => number;
  /** Callback invoked before each retry wait. */
  onRetry?: (info: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    error: unknown;
  }) => void;
  /** Whether to invoke `exitFn(1)` after exhausting all retries. */
  exitOnFailure?: boolean;
  /** Optional process exit function override for testing. */
  exitFn?: (code: number) => void;
}

/**
 * Computes exponential backoff delay with optional bounded jitter:
 * `min(maxDelayMs, baseDelayMs * 2^(attempt - 1)) ± jitter`.
 */
export function computeDbRetryDelayMs(
  attempt: number,
  options: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    random?: () => number;
  } = {},
): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_DB_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_DB_MAX_DELAY_MS;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;

  const normalizedAttempt = Math.max(1, attempt);
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, normalizedAttempt - 1));
  if (jitterRatio <= 0) {
    return Math.round(exponential);
  }

  const jitterOffset = exponential * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitterOffset));
}

/**
 * Connects to PostgreSQL via Prisma with an exponential backoff + jitter retry
 * loop (default 5 attempts) to survive transient container boot ordering or
 * brief network blips (#537).
 */
export async function connectWithRetry(
  optionsOrRetries: number | DbConnectionRetryOptions = {},
  legacyBaseDelayMs?: number,
): Promise<void> {
  const opts: DbConnectionRetryOptions =
    typeof optionsOrRetries === 'number'
      ? { maxRetries: optionsOrRetries, baseDelayMs: legacyBaseDelayMs }
      : optionsOrRetries;

  const maxRetries = Math.max(1, opts.maxRetries ?? DEFAULT_DB_MAX_RETRIES);
  const targetClient = opts.client ?? prisma;
  const sleepFn =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const exitFn = opts.exitFn ?? ((code: number) => process.exit(code));

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await targetClient.$connect();
      if (attempt > 1) {
        console.log(`[Prisma] ✅ Database connection established on attempt ${attempt}/${maxRetries}.`);
      }
      return;
    } catch (error) {
      if (attempt >= maxRetries) {
        console.error(
          `[Prisma] ❌ Exhausted all ${maxRetries} database connection attempts.`,
          error instanceof Error ? error.message : error,
        );
        if (opts.exitOnFailure) {
          exitFn(1);
        }
        throw error;
      }

      const delayMs = computeDbRetryDelayMs(attempt, {
        baseDelayMs: opts.baseDelayMs,
        maxDelayMs: opts.maxDelayMs,
        jitterRatio: opts.jitterRatio,
        random: opts.random,
      });

      opts.onRetry?.({ attempt, maxRetries, delayMs, error });
      console.warn(
        `[Prisma] ⚠️ Database connection attempt ${attempt}/${maxRetries} failed (${
          error instanceof Error ? error.message : String(error)
        }). Retrying in ${delayMs}ms...`,
      );

      await sleepFn(delayMs);
    }
  }
}
