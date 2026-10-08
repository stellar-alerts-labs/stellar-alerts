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
 * Probe a Postgres URL by TCP-connecting to its host:port, then verifying
 * credentials with an authenticated `SELECT 1`. TCP-only probes report
 * "available" when the port is open even if the user/password/database are
 * wrong, which turns a clean skip into a suite failure (28P01). The
 * authenticated check lets suites skip cleanly when the service is
 * unreachable *or* the credentials don't match this fixture's URL.
 */
export async function isPostgresAvailable(url: string): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`Unsupported database URL: ${url}`);
  }
  const key = `pg|${url}`;
  const cached = availabilityCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.available;

  const tcpOk = await probeTcp(
    parsed.hostname || 'localhost',
    Number(parsed.port || 5432),
    PROBE_TIMEOUT_MS,
  );
  if (!tcpOk) {
    availabilityCache.set(key, { available: false, at: now });
    return false;
  }

  let available = false;
  try {
    const { Client } = await import('pg');
    const client = new Client({
      connectionString: url,
      connectionTimeoutMillis: PROBE_TIMEOUT_MS,
      query_timeout: PROBE_TIMEOUT_MS,
    });
    await client.connect();
    try {
      await client.query('SELECT 1');
      available = true;
    } finally {
      await client.end().catch(() => undefined);
    }
  } catch {
    available = false;
  }
  availabilityCache.set(key, { available, at: Date.now() });
  return available;
}

export async function isRedisAvailable(url: string): Promise<boolean> {
  const { host, port } = parseRedisUrl(url);
  const key = `redis|${url}`;
  const cached = availabilityCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.available;

  const tcpOk = await probeTcp(host, port, PROBE_TIMEOUT_MS);
  if (!tcpOk) {
    availabilityCache.set(key, { available: false, at: now });
    return false;
  }

  let available = false;
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis({
      host,
      port,
      connectTimeout: PROBE_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      retryStrategy: () => null,
      lazyConnect: false,
    });
    try {
      const pong = await client.ping();
      available = pong === 'PONG';
    } finally {
      client.disconnect();
    }
  } catch {
    available = false;
  }
  availabilityCache.set(key, { available, at: Date.now() });
  return available;
}
