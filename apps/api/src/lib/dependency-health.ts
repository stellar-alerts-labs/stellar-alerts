import { env } from '../config/env';
import { prisma } from './prisma';
import { checkRedisReadiness } from './redis';

export type DependencyStatus = 'healthy' | 'unhealthy';

export interface DependencyCheck {
  status: DependencyStatus;
  latencyMs: number;
  error?: string;
}

export interface DependencyHealthReport {
  status: 'ready' | 'degraded';
  checkedAt: string;
  dependencies: {
    database: DependencyCheck;
    redis: DependencyCheck;
    horizon: DependencyCheck;
    soroban: DependencyCheck;
  };
}

const CHECK_TIMEOUT_MS = env.HEALTH_CHECK_TIMEOUT_MS;
const CACHE_TTL_MS = env.HEALTH_CHECK_CACHE_TTL_MS;

let cachedReport: DependencyHealthReport | undefined;
let cacheExpiresAt = 0;
let pendingCheck: Promise<DependencyHealthReport> | undefined;

async function measureCheck(
  name: string,
  operation: (signal: AbortSignal) => Promise<unknown>,
): Promise<DependencyCheck> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timeoutHandle!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`));
    }, CHECK_TIMEOUT_MS);
  });

  try {
    await Promise.race([operation(controller.signal), timeout]);
    return { status: 'healthy', latencyMs: Date.now() - startedAt };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    const message = error instanceof Error ? error.message : '';
    const isTimeout = message.toLowerCase().includes('timeout');
    const safeMessage = message
      .replace(/\b(?:postgres(?:ql)?|redis):\/\/[^\s'"<>]+/gi, '[connection string]')
      .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
      .slice(0, 160);
    const detail = isTimeout
      ? `timed out after ${CHECK_TIMEOUT_MS}ms`
      : typeof code === 'string'
        ? `request failed (${code})`
        : safeMessage || 'request failed';

    return {
      status: 'unhealthy',
      latencyMs: Date.now() - startedAt,
      error: `${name} ${detail}`,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function checkDatabase(signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw signal.reason;
  return prisma.$queryRaw`SELECT 1`;
}

async function checkRedis(): Promise<unknown> {
  const result = await checkRedisReadiness(CHECK_TIMEOUT_MS);
  if (!result.isReady) throw new Error(result.error || 'Redis is not ready');
  return result;
}

async function checkHorizon(signal: AbortSignal): Promise<unknown> {
  const response = await fetch(new URL('/', env.HORIZON_URL), { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.body?.cancel();
}

async function checkSoroban(signal: AbortSignal): Promise<unknown> {
  const response = await fetch(env.SOROBAN_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const result = await response.json() as { error?: { code?: number }; result?: { sequence?: number } };
  if (result.error) throw new Error(`RPC error ${result.error.code ?? 'unknown'}`);
  if (!Number.isInteger(result.result?.sequence)) throw new Error('invalid RPC response');
}

async function collectDependencyHealth(): Promise<DependencyHealthReport> {
  const [database, redis, horizon, soroban] = await Promise.all([
    measureCheck('PostgreSQL', checkDatabase),
    measureCheck('Redis', checkRedis),
    measureCheck('Horizon', checkHorizon),
    measureCheck('Soroban RPC', checkSoroban),
  ]);
  const dependencies = { database, redis, horizon, soroban };
  const ready = Object.values(dependencies).every((dependency) => dependency.status === 'healthy');

  return {
    status: ready ? 'ready' : 'degraded',
    checkedAt: new Date().toISOString(),
    dependencies,
  };
}

export function getDependencyHealth(): Promise<DependencyHealthReport> {
  if (cachedReport && Date.now() < cacheExpiresAt) {
    return Promise.resolve(cachedReport);
  }
  if (pendingCheck) return pendingCheck;

  pendingCheck = collectDependencyHealth()
    .then((report) => {
      cachedReport = report;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return report;
    })
    .finally(() => {
      pendingCheck = undefined;
    });

  return pendingCheck;
}