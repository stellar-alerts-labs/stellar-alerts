import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryRaw = vi.fn();
const mockRedisPing = vi.fn();
const mockGetLatestLedger = vi.fn();

vi.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock('../lib/queue', () => ({
  alertQueue: {
    client: Promise.resolve({
      ping: () => mockRedisPing(),
    }),
  },
}));

vi.mock('../lib/soroban', () => ({
  sorobanServer: {
    getLatestLedger: () => mockGetLatestLedger(),
  },
}));

vi.mock('../lib/redis', () => ({
  checkRedisReadiness: vi.fn().mockResolvedValue(false),
  getRedisStatus: vi.fn().mockReturnValue('ready'),
}));

vi.mock('../lib/db-failover', () => ({
  dbFailover: {},
}));

vi.mock('../plugins/prisma', () => ({ default: async () => {} }));
vi.mock('../plugins/metrics', () => ({ default: async () => {} }));
vi.mock('../plugins/degraded-mode', () => ({ default: async () => {} }));
vi.mock('../plugins/websocket', () => ({ registerSSEPushPlugin: async () => {} }));

vi.mock('../modules/auth/auth.routes', () => ({ authRoutes: async () => {} }));
vi.mock('../modules/wallets/wallets.routes', () => ({ walletsRoutes: async () => {} }));
vi.mock('../modules/payments/payments.routes', () => ({ paymentsRoutes: async () => {} }));
vi.mock('../modules/webhooks/webhooks.routes', () => ({ webhooksRoutes: async () => {} }));
vi.mock('../modules/account/account.routes', () => ({ accountRoutes: async () => {} }));
vi.mock('../modules/soroban-state/soroban-state.routes', () => ({ sorobanStateRoutes: async () => {} }));
vi.mock('../modules/notifications/notifications.routes', () => ({ notificationsRoutes: async () => {} }));
vi.mock('../modules/alert-rules/alert-rules.routes', () => ({ alertRulesRoutes: async () => {} }));
vi.mock('../modules/dead-letters/dead-letters.routes', () => ({ deadLettersRoutes: async () => {} }));
vi.mock('../modules/discord-interactions', () => ({ discordInteractionsRoutes: async () => {} }));
vi.mock('../modules/slack/slack.routes', () => ({ slackRoutes: async () => {} }));
vi.mock('../modules/graphql/graphql.routes', () => ({ graphqlRoutes: async () => {} }));
vi.mock('../modules/exports/exports.routes', () => ({ exportsRoutes: async () => {} }));
vi.mock('../modules/simulation/simulation.routes', () => ({ simulationRoutes: async () => {} }));

import { buildApp } from '../app';

describe('Deep Health Inspection Probe (GET /health/deep)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 OK when Postgres, Redis, and Horizon all respond', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockRedisPing.mockResolvedValueOnce('PONG');
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 12345 });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/deep' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'ok',
      checks: {
        postgres: 'ok',
        redis: 'ok',
        horizon: 'ok',
      },
    });
    await app.close();
  });

  it('returns 503 Service Unavailable when PostgreSQL is down', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error('DB connection refused'));
    mockRedisPing.mockResolvedValueOnce('PONG');
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 12345 });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/deep' });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      status: 'degraded',
      checks: {
        postgres: 'error',
        redis: 'ok',
        horizon: 'ok',
      },
    });
    await app.close();
  });

  it('returns 503 Service Unavailable when Redis or Horizon fails', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockRedisPing.mockRejectedValueOnce(new Error('Redis timeout'));
    mockGetLatestLedger.mockRejectedValueOnce(new Error('Horizon RPC unreachable'));

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/deep' });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      status: 'degraded',
      checks: {
        postgres: 'ok',
        redis: 'error',
        horizon: 'error',
      },
    });
    await app.close();
  });
});
