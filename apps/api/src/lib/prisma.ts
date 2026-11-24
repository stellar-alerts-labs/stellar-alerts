import { PrismaClient } from '../../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';
import { resolvePoolConfig } from './db-pool';
import {
  MUTATION_OPERATIONS,
  configureCausalRouter,
  createCausalReadProxy,
  getCausalContext,
  getCausalRouter,
  recordMutationForContext,
} from './prisma-causal-router';

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

/**
 * Wraps every mutation delegate so a successful write records the primary WAL
 * LSN for the current user's RYOW watermark. Failures (Redis unavailable, LSN
 * probe failure) must never turn a successful database write into a failed
 * API request, so watermark recording is best-effort and logged.
 */
async function recordWatermarkAfterMutation(result: unknown): Promise<unknown> {
  try {
    await recordMutationForContext();
  } catch (error: any) {
    console.warn(`[RYOW] Failed to record mutation watermark: ${error?.message || error}`);
  }
  return result;
}

function wrapMutationDelegate(delegate: object): object {
  return new Proxy(delegate, {
    get(target, method, receiver) {
      const value = Reflect.get(target, method, receiver);
      if (typeof value !== 'function' || !MUTATION_OPERATIONS.has(String(method))) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const result = await (value as (...args: unknown[]) => unknown).apply(target, args);
        return recordWatermarkAfterMutation(result);
      };
    },
  });
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const value = (primaryClient as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      // `$transaction` receives its own client, so delegate-level wrapping does
      // not observe writes made inside it. Record once on completion instead.
      if (prop === '$transaction') {
        return async (...args: unknown[]) =>
          recordWatermarkAfterMutation(
            await (value as (...args: unknown[]) => unknown).apply(primaryClient, args),
          );
      }
      return (value as (...args: unknown[]) => unknown).bind(primaryClient);
    }
    if (value && typeof value === 'object') {
      return wrapMutationDelegate(value as object);
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

// The LSN probes live here so they follow the primary client across DR
// promotions; the causal router itself stays free of a prisma import cycle.
configureCausalRouter({
  getPrimaryLsn: async () => {
    const rows = await primaryClient.$queryRaw<Array<{ lsn: string }>>`
      SELECT pg_current_wal_lsn()::text AS lsn
    `;
    return rows[0]?.lsn ?? '';
  },
  getReplicaLsn: async () => {
    // With no configured replica the "replica" is the primary itself, which
    // is by definition caught up with its own WAL.
    if (!replicaUrl) {
      const rows = await primaryClient.$queryRaw<Array<{ lsn: string }>>`
        SELECT pg_current_wal_lsn()::text AS lsn
      `;
      return rows[0]?.lsn ?? '';
    }
    const rows = await prismaRead.$queryRaw<Array<{ lsn: string }>>`
      SELECT pg_last_wal_replay_lsn()::text AS lsn
    `;
    return rows[0]?.lsn ?? '';
  },
});

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
  const client = activeReadTarget === 'PRIMARY' ? prisma : prismaRead;
  const context = getCausalContext();
  if (client === prisma || !context?.userId) return client;
  return createCausalReadProxy(context.userId, { primary: prisma, replica: client }, getCausalRouter());
}

/**
 * Explicit form of {@link getReadClient} for jobs that know the user but do
 * not run inside a request's causal context.
 */
export function getCausalReadClient(userId: string) {
  if (activeReadTarget === 'PRIMARY') return prisma;
  return createCausalReadProxy(userId, { primary: prisma, replica: prismaRead }, getCausalRouter());
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

export async function connectWithRetry() {
  await prisma.$connect();
}
