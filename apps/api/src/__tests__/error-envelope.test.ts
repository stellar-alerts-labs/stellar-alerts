/**
 * Contract tests for the unified error envelope (issue #284).
 *
 * Unlike the per-controller unit tests (which assert a controller throws
 * the right AppError subclass), these boot the real Fastify app built by
 * `buildApp()` — including app.ts's setErrorHandler and the real
 * authenticateHook middleware — and hit real routes with `app.inject()`,
 * asserting the actual HTTP status code and response body shape a client
 * would receive for each error category the issue calls out: validation,
 * authentication, authorization, not-found, conflict, and provider errors.
 *
 * Every case also asserts the response body contains no sensitive detail
 * (no stack trace, no raw Prisma/Postgres error text) — only a stable
 * `code`, a safe `message`, and the `requestId` correlation id.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../config/env', () => ({
  env: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    TELEGRAM_BOT_TOKEN: 'test-token',
    JWT_SECRET: 'test-super-secret-jwt-key-for-testing-only',
    REDIS_URL: 'redis://localhost:6379',
    PORT: '3001',
    RATE_LIMIT_MAX: 1000,
    WASM_ANALYZER_MAX_UPLOAD_BYTES: 1024 * 1024,
    HORIZON_REQUEST_TIMEOUT_MS: 5000,
  },
}));

vi.mock('../lib/prisma', () => {
  const mockPrisma: any = {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    payment: { findFirst: vi.fn() },
    wallet: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn(), create: vi.fn() },
  };
  return {
    prisma: mockPrisma,
    prismaRead: mockPrisma,
    replicaPrisma: mockPrisma,
    getReadClient: () => mockPrisma,
    setReadTarget: vi.fn(),
  };
});

vi.mock('../lib/queue', () => ({
  alertQueue: null,
  enqueuePaymentAlert: vi.fn().mockResolvedValue(null),
}));

vi.mock('../modules/notifications/notifications.service', () => ({
  notificationsService: {
    sendTestPing: vi.fn(),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
  },
}));

import { buildApp } from '../app';
import type { FastifyInstance } from 'fastify';
import { generateAccessToken } from '../utils/jwt';
import { prisma } from '../lib/prisma';
import { notificationsService } from '../modules/notifications/notifications.service';

describe('Error envelope contract (issue #284)', () => {
  let app: FastifyInstance;
  let authToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    authToken = generateAccessToken({ id: 'user-1', email: 'user-1@example.com' });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Every error envelope must have this shape and never leak internals. */
  function expectEnvelope(body: any, expectedCode: string) {
    expect(body).toHaveProperty('error');
    expect(body.error).toMatchObject({ code: expectedCode, message: expect.any(String) });
    expect(body.error).toHaveProperty('requestId');
    expect(typeof body.error.requestId).toBe('string');

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // no stack trace lines
    expect(serialized.toLowerCase()).not.toContain('prisma');
    expect(serialized.toLowerCase()).not.toContain('postgres');
  }

  it('validation error: malformed query returns 400 with VALIDATION_ERROR envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/payments?sortBy=fromAddress', // not one of the allowed enum values
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expectEnvelope(body, 'VALIDATION_ERROR');
    expect(body.error.details).toBeDefined();
  });

  it('authentication error: no Authorization header returns 401 with AUTH_REQUIRED envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/payments',
    });

    expect(response.statusCode).toBe(401);
    expectEnvelope(response.json(), 'AUTH_REQUIRED');
  });

  it('authentication error: invalid/garbage token returns 401 with INVALID_TOKEN envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/payments',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    });

    expect(response.statusCode).toBe(401);
    expectEnvelope(response.json(), 'INVALID_TOKEN');
  });

  it('authorization error: fetching another user\'s receipt returns 403 with FORBIDDEN envelope', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue({
      id: 'pay-1',
      txHash: 'tx-1',
      wallet: { userId: 'someone-else', publicKey: 'GABC', label: null, user: { email: 'other@example.com' } },
    } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/payments/tx-1/receipt',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(403);
    expectEnvelope(response.json(), 'FORBIDDEN');
  });

  it('not-found error: receipt for an unknown transaction returns 404 with NOT_FOUND envelope', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: '/payments/does-not-exist/receipt',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(404);
    expectEnvelope(response.json(), 'NOT_FOUND');
  });

  it('conflict error: registering a duplicate wallet returns 409 with CONFLICT envelope', async () => {
    const p2002: any = new Error('Unique constraint failed on the fields: (`publicKey`)');
    p2002.code = 'P2002';
    vi.mocked(prisma.wallet.create).mockRejectedValue(p2002);

    const response = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72' },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expectEnvelope(body, 'CONFLICT');
    // The raw Prisma constraint-violation message must never reach the client.
    expect(JSON.stringify(body)).not.toContain('Unique constraint failed');
  });

  it('provider error: a failed test-ping send returns 502 with a provider-error envelope', async () => {
    vi.mocked(notificationsService.sendTestPing).mockResolvedValue({
      success: false,
      message: 'Telegram API returned 403: bot was blocked by the user',
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/notifications/test-ping',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { channel: 'telegram' },
    });

    expect(response.statusCode).toBe(502);
    expectEnvelope(response.json(), 'TEST_PING_PROVIDER_FAILURE');
  });

  it('every error response echoes the same x-request-id in both the header and the envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/payments',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.requestId).toBe(response.headers['x-request-id']);
  });
});
