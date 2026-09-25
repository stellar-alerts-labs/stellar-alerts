/**
 * Idempotency key middleware (#334).
 *
 * These drive a real Fastify instance built by `buildApp()`, so the assertions
 * are about observed HTTP behaviour — status codes, headers and handler
 * invocation counts — rather than about the middleware's internals. The
 * database is replaced with an in-memory fake that reproduces the two
 * properties the protocol depends on: a unique constraint on `(key, scope)`
 * and read-your-writes.
 *
 * The cases the protocol has to get right:
 *   1. a first request runs the handler and is recorded
 *   2. a retry replays the stored response and does NOT run the handler
 *   3. a retry while the first is still in flight gets 409
 *   4. the same key with a different body gets 422
 *   5. no header means no behaviour change
 *   6. a 5xx releases the reservation so the retry really re-runs
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

// ---------------------------------------------------------------------------
// Environment + prisma fake, installed before the app is imported.
// ---------------------------------------------------------------------------

vi.mock('../../config/env', () => ({
  env: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    TELEGRAM_BOT_TOKEN: 'test-token',
    JWT_SECRET: 'test-super-secret-jwt-key-for-testing-only',
    REDIS_URL: 'redis://localhost:6379',
    PORT: '3001',
    RATE_LIMIT_MAX: 100000,
  },
}));

// `vi.mock` factories are hoisted above imports, so the fake store must be
// created inside `vi.hoisted` to exist by the time they run.
const store = vi.hoisted(() => {
  interface Row {
    id: string;
    key: string;
    scope: string;
    userId: string | null;
    requestHash: string;
    status: string;
    statusCode: number | null;
    response: string | null;
    expiresAt: Date;
  }

  const rows: Row[] = [];
  let seq = 0;
  /** Records every create() call so tests can assert on what was written. */
  const createCalls: { data: Partial<Row> }[] = [];

  const find = (key: string, scope: string) =>
    rows.find((r) => r.key === key && r.scope === scope);

  const store = {
    rows,
    createCalls,
    createSpy: { mock: { calls: createCalls } },
    reset() {
      rows.length = 0;
      createCalls.length = 0;
      seq = 0;
    },
    create: async (args: { data: Partial<Row> }) => {
      createCalls.push(args);
      const { key, scope } = args.data as { key: string; scope: string };
      if (find(key, scope)) {
        const err: Error & { code?: string } = new Error('Unique constraint failed');
        err.code = 'P2002';
        throw err;
      }
      const row: Row = {
        id: `idem_${++seq}`,
        key,
        scope,
        userId: (args.data.userId as string | null) ?? null,
        requestHash: args.data.requestHash as string,
        status: (args.data.status as string) ?? 'in_progress',
        statusCode: null,
        response: null,
        expiresAt: (args.data.expiresAt as Date) ?? new Date(),
      };
      rows.push(row);
      return { id: row.id };
    },
    findUnique: async (args: { where: { key_scope: { key: string; scope: string } } }) => {
      const { key, scope } = args.where.key_scope;
      const row = find(key, scope);
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        statusCode: row.statusCode,
        response: row.response,
        requestHash: row.requestHash,
      };
    },
    update: async (args: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) throw new Error(`no row ${args.where.id}`);
      Object.assign(row, args.data);
      return row;
    },
    delete: async (args: { where: { id: string } }) => {
      const i = rows.findIndex((r) => r.id === args.where.id);
      if (i >= 0) rows.splice(i, 1);
      return { id: args.where.id };
    },
    findMany: async () => [] as Row[],
    deleteMany: async () => ({ count: 0 }),
  };

  return store;
});

vi.mock('../../lib/prisma', () => {
  // The prisma Fastify plugin calls $connect / $queryRaw / $disconnect during
  // boot and on close; the idempotency middleware uses the idempotencyKey
  // delegate. Both must resolve from the same object.
  const client: Record<string, unknown> = {
    idempotencyKey: store,
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  };

  const proxy = new Proxy(client, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      // Unused delegates: no-ops keep importing the app from exploding.
      return new Proxy({}, { get: () => vi.fn(async () => null) });
    },
  });

  return {
    prisma: proxy,
    prismaRead: proxy,
    replicaPrisma: proxy,
    getReadClient: () => proxy,
  };
});

vi.mock('../../lib/queue', () => ({
  alertQueue: null,
  enqueuePaymentAlert: vi.fn().mockResolvedValue(null),
}));

// `authenticateHook` guards the mutation routes; stub it so these tests focus
// on idempotency and do not need to mint real tokens.
vi.mock('../../middleware/auth.middleware', () => ({
  authenticateHook: async (request: { user?: unknown }) => {
    request.user = { id: 'user-1', email: 'test@example.com' };
  },
}));

// ---------------------------------------------------------------------------

import { buildApp } from '../../app';
import { fingerprintRequest, idempotencyHooks } from '../idempotency.middleware';

let app: FastifyInstance;
/** Counts how many times a test handler body ran. */
let handlerRuns = 0;

/** Register a route that counts its own executions and can be made to fail. */
function registerCountingRoute(
  url: string,
  behaviour: (attempt: number) => { status?: number; body: unknown } = () => ({
    body: { created: true },
  })
) {
  let attempts = 0;
  const hooks = idempotencyHooks({ ttlMs: 60_000 });

  app.post(
    url,
    { preValidation: hooks.preValidation, onSend: hooks.onSend, onResponse: hooks.onResponse },
    async (_req, reply) => {
    attempts += 1;
    handlerRuns += 1;
    const { status = 200, body } = behaviour(attempts);
    return reply.status(status).send(body);
  });

  return { attempts: () => attempts };
}

function post(
  url: string,
  headers: Record<string, string> = {},
  payload: unknown = { a: 1 }
): Promise<LightMyRequestResponse> {
  const opts: InjectOptions = { method: 'POST', url, headers, payload: payload as never };
  return app.inject(opts);
}

beforeAll(async () => {
  app = await buildApp();
  // Routes must exist before ready(); Fastify refuses to add them afterwards.
  registerCountingRoute('/__test/mutate');
  registerCountingRoute('/__test/created', () => ({
    status: 201,
    body: { id: 'wallet-1' },
  }));
  registerCountingRoute('/__test/flaky', (attempt) =>
    attempt === 1 ? { status: 500, body: { error: 'transient' } } : { body: { ok: true } }
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  store.reset();
  handlerRuns = 0;
  vi.clearAllMocks();
});

const KEY = 'client-generated-key-1';

describe('idempotency middleware (#334)', () => {
  it('does not change behaviour when no Idempotency-Key is sent', async () => {
    const first = await post('/__test/mutate');
    const second = await post('/__test/mutate');

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Both ran: without a key there is nothing to deduplicate on.
    expect(handlerRuns).toBe(2);
    expect(store.createCalls).toHaveLength(0);
  });

  it('runs the handler once and replays the stored response on retry', async () => {
    const first = await post('/__test/mutate', { 'idempotency-key': KEY });
    expect(first.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);

    const second = await post('/__test/mutate', { 'idempotency-key': KEY });
    expect(second.statusCode).toBe(200);

    // The handler ran exactly once across both calls.
    expect(handlerRuns).toBe(1);

    // The retry is identical to the original.
    expect(second.body).toBe(first.body);
    expect(second.json()).toEqual(first.json());
  });

  it('marks a fresh response and a replay distinctly', async () => {
    const fresh = await post('/__test/mutate', { 'idempotency-key': KEY });
    expect(fresh.headers['idempotency-replayed']).toBe('false');

    const replay = await post('/__test/mutate', { 'idempotency-key': KEY });
    expect(replay.headers['idempotency-replayed']).toBe('true');
  });

  it('preserves the original status code on replay', async () => {
    const headers = { 'idempotency-key': 'created-key' };
    const first = await post('/__test/created', headers, {});
    const second = await post('/__test/created', headers, {});

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual({ id: 'wallet-1' });
  });

  it('rejects a concurrent duplicate with 409 instead of running it twice', async () => {
    // The row a concurrent request would have left behind.
    store.rows.push({
      id: 'idem_held',
      key: KEY,
      scope: 'POST /__test/mutate',
      userId: null,
      requestHash: fingerprintRequest({ body: { a: 1 } } as never),
      status: 'in_progress',
      statusCode: null,
      response: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await post('/__test/mutate', { 'idempotency-key': KEY });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(handlerRuns).toBe(0);
  });

  it('rejects the same key used with a different body as 422', async () => {
    const first = await post('/__test/mutate', { 'idempotency-key': KEY }, { a: 1 });
    expect(first.statusCode).toBe(200);
    expect(handlerRuns).toBe(1);

    const conflicting = await post('/__test/mutate', { 'idempotency-key': KEY }, { a: 2 });

    expect(conflicting.statusCode).toBe(422);
    expect(conflicting.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    // The mismatched request never reached the handler.
    expect(handlerRuns).toBe(1);
  });

  it('releases the reservation when the handler fails with 5xx', async () => {
    const headers = { 'idempotency-key': 'flaky-key' };
    const failed = await post('/__test/flaky', headers, {});
    expect(failed.statusCode).toBe(500);

    // The retry must actually re-run the handler, not replay the 500.
    const retried = await post('/__test/flaky', headers, {});

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ ok: true });
  });

  it('records the reservation with a route scope and an expiry', async () => {
    await post('/__test/mutate', { 'idempotency-key': KEY });

    expect(store.createCalls).toHaveLength(1);
    const data = store.createCalls[0].data;
    expect(data.key).toBe(KEY);
    expect(data.scope).toBe('POST /__test/mutate');
    expect(data.status).toBe('in_progress');
    expect(data.expiresAt).toBeInstanceOf(Date);
  });
});

describe('fingerprintRequest', () => {
  const req = (body: unknown) => ({ body } as never);

  it('is stable regardless of JSON key order', () => {
    expect(fingerprintRequest(req({ a: 1, b: 2 }))).toBe(
      fingerprintRequest(req({ b: 2, a: 1 }))
    );
  });

  it('differs when a value differs', () => {
    expect(fingerprintRequest(req({ a: 1 }))).not.toBe(
      fingerprintRequest(req({ a: 2 }))
    );
  });

  it('differs when a key is added', () => {
    expect(fingerprintRequest(req({ a: 1 }))).not.toBe(
      fingerprintRequest(req({ a: 1, b: 2 }))
    );
  });

  it('treats a missing body and an empty body alike', () => {
    expect(fingerprintRequest(req(undefined))).toBe(fingerprintRequest(req(null)));
  });

  it('ignores fields named in ignoredBodyFields', () => {
    expect(fingerprintRequest(req({ a: 1, nonce: 'x' }), ['nonce'])).toBe(
      fingerprintRequest(req({ a: 1, nonce: 'y' }), ['nonce'])
    );
  });

  it('still differs on non-ignored fields when a field is ignored', () => {
    expect(fingerprintRequest(req({ a: 1, nonce: 'x' }), ['nonce'])).not.toBe(
      fingerprintRequest(req({ a: 2, nonce: 'x' }), ['nonce'])
    );
  });
});
