import { randomUUID } from 'crypto';
import Redis from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

// Lua script for atomic release: only delete the key if the token matches
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

let lockRedis: Redis | null = null;

function getLockRedis(): Redis {
  if (!lockRedis) {
    lockRedis = new Redis({
      host: redisHost,
      port: redisPort,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    lockRedis.on('error', (err) => {
      console.warn(`[Lock] Redis connection error: ${err.message}`);
    });
  }
  return lockRedis;
}

export interface LockHandle {
  acquired: boolean;
  token: string;
  release: () => Promise<void>;
}

/**
 * Acquires a distributed mutex lock for a wallet address.
 * Uses Redis SET NX PX pattern (atomic acquire).
 *
 * @param walletKey - The wallet public key (used as lock key)
 * @param ttlMs     - Lock TTL in milliseconds (default 30_000)
 *
 * Fail-open behavior: if Redis is unavailable, `acquired` is set to `true`
 * so processing continues unblocked.
 */
export async function acquireWalletLock(walletKey: string, ttlMs = 30_000): Promise<LockHandle> {
  const lockKey = `lock:wallet:${walletKey}`;
  const token = randomUUID();

  // Noop release used in fail-open / not-acquired paths
  const noopRelease = async () => {};

  try {
    const client = getLockRedis();
    const result = await client.set(lockKey, token, 'NX', 'PX', ttlMs);

    if (result === 'OK') {
      // Lock acquired — return a handle that atomically releases via Lua
      return {
        acquired: true,
        token,
        release: async () => {
          try {
            await client.eval(RELEASE_SCRIPT, 1, lockKey, token);
          } catch (err: any) {
            console.warn(`[Lock] Failed to release lock for ${walletKey.substring(0, 8)}...: ${err.message}`);
          }
        },
      };
    }

    // Another process holds the lock
    return { acquired: false, token, release: noopRelease };
  } catch (err: any) {
    // Redis unavailable — fail-open so processing is not stalled
    console.warn(`[Lock] Redis unavailable, proceeding fail-open for ${walletKey.substring(0, 8)}...: ${err.message}`);
    return { acquired: true, token, release: noopRelease };
  }
}
