/**
 * Integration tests for x-request-id correlation ID behaviour (Issue #44).
 *
 * These tests exercise the Fastify app built by `buildApp` to verify:
 *  - A fresh UUID is generated and echoed back when no header is sent.
 *  - A client-supplied `x-request-id` header is accepted and echoed back.
 *  - The response header value matches the request ID format (UUID v4).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the app can boot without real DB / Redis / env
// ---------------------------------------------------------------------------
vi.mock('../../config/env', () => ({
  env: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    TELEGRAM_BOT_TOKEN: 'test-token',
    JWT_SECRET: 'test-super-secret-jwt-key-for-testing-only',
    REDIS_URL: 'redis://localhost:6379',
    PORT: '3001',
  },
}));

vi.mock('../../lib/prisma', () => {
  const mockPrisma = {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
  return {
    prisma: mockPrisma,
    prismaRead: mockPrisma,
    replicaPrisma: mockPrisma,
    getReadClient: () => mockPrisma,
  };
});

vi.mock('../../lib/queue', () => ({
  alertQueue: null,
  enqueuePaymentAlert: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../lib/dependency-health', () => ({
  getDependencyHealth: vi.fn(),
}));

// ---------------------------------------------------------------------------

import { buildApp } from '../../app';
import { getDependencyHealth } from '../dependency-health';
import type { FastifyInstance } from 'fastify';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('x-request-id correlation ID (Issue #44)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('generates a UUID v4 x-request-id when none is sent by the client', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    const id = response.headers['x-request-id'];
    expect(typeof id).toBe('string');
    expect(id).toMatch(UUID_V4_RE);
  });

  it('echoes back a client-supplied x-request-id unchanged', async () => {
    const clientId = 'my-trace-id-abc-123';
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': clientId },
    });

    expect(response.headers['x-request-id']).toBe(clientId);
  });

  it('generates a different ID for each request when no header is sent', async () => {
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/health' }),
    ]);

    const id1 = r1.headers['x-request-id'];
    const id2 = r2.headers['x-request-id'];

    expect(id1).not.toBe(id2);
    expect(id1).toMatch(UUID_V4_RE);
    expect(id2).toMatch(UUID_V4_RE);
  });

  it('returns 200 OK from the health endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('keeps liveness independent from dependency checks', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(getDependencyHealth).not.toHaveBeenCalled();
  });

  it('reports degraded dependencies and returns 503 from readiness', async () => {
    vi.mocked(getDependencyHealth).mockResolvedValueOnce({
      status: 'degraded',
      checkedAt: '2026-09-27T12:00:00.000Z',
      dependencies: {
        database: { status: 'healthy', latencyMs: 2 },
        redis: { status: 'unhealthy', latencyMs: 1500, error: 'Redis timed out after 1500ms' },
        horizon: { status: 'healthy', latencyMs: 10 },
        soroban: { status: 'healthy', latencyMs: 12 },
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json().dependencies.redis.error).toContain('timed out');
    expect(response.json().dependencies.database.status).toBe('healthy');
    expect(response.json().redis).toMatchObject({ isReady: false, isDegradedMode: true });
  });
});
