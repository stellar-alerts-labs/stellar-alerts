import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { isRedisAvailable, parseRedisUrl } from './test-infra';

/**
 * Redis integration fixtures.
 *
 * Strategy for parallel-safe, disposable test Redis:
 * - Each fork gets a dedicated logical database index (db0..db15) derived from
 *   the worker id, so concurrent forks never see each other's keys.
 * - A unique key prefix (`sa-it:<uuid>:`) further namespaces the fork's keys,
 *   making the fixture safe against prefix-unaware clients (e.g. BullMQ
 *   `<prefix>:<queue>` keys collide on shared dbs) and letting `reset()` be a
 *   deterministic, targeted SCAN+DEL instead of FLUSHDB.
 * - On teardown only keys under the prefix are removed, then the connection is
 *   quit — nothing disposable survives the run.
 */

const PREFIX = 'sa-it:';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ??
  'redis://localhost:6379';

export interface RedisFixture {
  /** ioredis client bound to the fork's db index. */
  redis: Redis;
  /** Unique key prefix used by this fixture instance. */
  prefix: string;
  /** Deterministic SCAN+DEL of every key under the prefix. */
  reset: () => Promise<void>;
  /** Delete remaining prefixed keys, then close the connection. */
  teardown: () => Promise<void>;
}

let dbIndexCursor: number | null = null;

function pickDbIndex(): number {
  const explicit = process.env.TEST_REDIS_DB;
  if (explicit && Number.isFinite(Number(explicit))) return Number(explicit);

  if (dbIndexCursor === null) {
    const workerId = Number(process.env.VITEST_POOL_ID ?? process.env.JEST_WORKER_ID ?? process.pid);
    dbIndexCursor = workerId % 16;
  }
  return dbIndexCursor;
}

export async function createRedisFixture(): Promise<RedisFixture> {
  if (!(await isRedisAvailable(TEST_REDIS_URL))) {
    throw new Error(
      `Integration fixtures need Redis at ${TEST_REDIS_URL} (start docker compose or set TEST_REDIS_URL)`,
    );
  }

  const { host, port } = parseRedisUrl(TEST_REDIS_URL);
  const db = pickDbIndex();
  const prefix = `${PREFIX}${randomUUID().slice(0, 8)}:`;

  const redis = new Redis({ host, port, db, maxRetriesPerRequest: 1, lazyConnect: false });

  const reset = async (): Promise<void> => {
    const pattern = `${prefix}*`;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  };

  const teardown = async (): Promise<void> => {
    await reset().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  };

  return { redis, prefix, reset, teardown };
}
