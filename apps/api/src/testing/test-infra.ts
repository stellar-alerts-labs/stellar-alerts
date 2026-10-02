import net from 'node:net';

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 10_000;

interface CacheEntry {
  available: boolean;
  at: number;
}

const availabilityCache = new Map<string, CacheEntry>();

/**
 * Does a TCP host:port accept connections before the timeout?
 */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (available: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(available);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export function parseRedisUrl(raw: string): { host: string; port: number } {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis URL: ${raw}`);
  }
  return {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port || 6379),
  };
}

/**
 * Probe a Postgres URL by TCP-connecting to its host:port. This avoids
 * booting a full Prisma client just to decide whether the real integration
 * fixtures can run, and short-circuits cheaply when the DB is down.
 */
export async function isPostgresAvailable(url: string): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`Unsupported database URL: ${url}`);
  }
  const key = `pg|${parsed.host}|${parsed.port}`;
  const cached = availabilityCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.available;

  const available = await probeTcp(
    parsed.hostname || 'localhost',
    Number(parsed.port || 5432),
    PROBE_TIMEOUT_MS,
  );
  availabilityCache.set(key, { available, at: now });
  return available;
}

export async function isRedisAvailable(url: string): Promise<boolean> {
  const { host, port } = parseRedisUrl(url);
  const key = `redis|${host}|${port}`;
  const cached = availabilityCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.available;

  const available = await probeTcp(host, port, PROBE_TIMEOUT_MS);
  availabilityCache.set(key, { available, at: now });
  return available;
}
