import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock('../lib/queue', () => ({
  alertQueue: null,
}));

vi.mock('../lib/soroban', () => ({
  sorobanServer: {
    getLatestLedger: vi.fn(),
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

describe('Request Rate Limiting Middleware (@fastify/rate-limit)', () => {
  it('allows 100 requests per minute and returns HTTP 429 with Retry-After on the 101st request', async () => {
    const app = await buildApp();

    for (let i = 1; i <= 100; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '203.0.113.42',
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '203.0.113.42',
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['x-ratelimit-limit']).toBe('100');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');

    await app.close();
  });
});
