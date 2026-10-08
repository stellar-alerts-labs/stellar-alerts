import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerIdempotency, IDEMPOTENCY_HEADER } from '../idempotency.middleware';

// ── Redis mock ────────────────────────────────────────────────────────────
// Use an in-memory Map to simulate the Redis SET/GET behaviour without
// requiring a live Redis instance.

const { redisStore } = vi.hoisted(() => {
  return {
    redisStore: new Map<string, { value: string; expiresAt: number }>(),
  };
});

vi.mock('../../lib/redis', () => {
  const store = redisStore;
  return {
    redis: {
      get: vi.fn(async (key: string) => {
        const entry = store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
          store.delete(key);
          return null;
        }
        return entry.value;
      }),
      set: vi.fn(async (key: string, value: string, _mode: string, ttl: number) => {
        store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
        return 'OK';
      }),
    },
  };
});

// ── Test app ──────────────────────────────────────────────────────────────

let callCount = 0;

async function buildTestApp() {
  const app = Fastify({ logger: false });

  // Simulate an authenticated user so the idempotency key is scoped per user.
  app.addHook('preHandler', async (request) => {
    (request as any).user = { id: 'user-test-123' };
  });

  await registerIdempotency(app);

  app.post('/wallets', async () => {
    callCount += 1;
    return { walletId: `wlt-${callCount}`, callCount };
  });

  app.delete('/wallets/:id', async (_req, reply) => {
    callCount += 1;
    return reply.status(200).send({ deleted: true, callCount });
  });

  app.get('/payments', async () => {
    callCount += 1;
    return { payments: [] };
  });

  await app.ready();
  return app;
}

describe('Idempotency middleware', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    callCount = 0;
    redisStore.clear();
  });

  it('processes a POST without an Idempotency-Key normally', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      payload: { publicKey: 'GABC' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).callCount).toBe(1);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
  });

  it('returns the cached response on a duplicate POST with the same key', async () => {
    const key = 'test-key-dup-001';
    const first = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { [IDEMPOTENCY_HEADER]: key },
      payload: { publicKey: 'GABC' },
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).callCount).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { [IDEMPOTENCY_HEADER]: key },
      payload: { publicKey: 'GABC' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotency-replayed']).toBe('true');
    // Handler was NOT called a second time.
    expect(JSON.parse(second.body).callCount).toBe(1);
    expect(callCount).toBe(1);
  });

  it('treats different keys as independent requests', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { [IDEMPOTENCY_HEADER]: 'key-A' },
      payload: {},
    });
    const second = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { [IDEMPOTENCY_HEADER]: 'key-B' },
      payload: {},
    });
    expect(JSON.parse(first.body).callCount).toBe(1);
    expect(JSON.parse(second.body).callCount).toBe(2);
    expect(second.headers['idempotency-replayed']).toBeUndefined();
  });

  it('does NOT apply idempotency to GET requests', async () => {
    const key = 'get-key-001';
    await app.inject({
      method: 'GET',
      url: '/payments',
      headers: { [IDEMPOTENCY_HEADER]: key },
    });
    await app.inject({
      method: 'GET',
      url: '/payments',
      headers: { [IDEMPOTENCY_HEADER]: key },
    });
    // Handler called twice — GET is not intercepted.
    expect(callCount).toBe(2);
  });

  it('works for DELETE mutations', async () => {
    const key = 'delete-key-001';
    const first = await app.inject({
      method: 'DELETE',
      url: '/wallets/wlt-1',
      headers: { [IDEMPOTENCY_HEADER]: key },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'DELETE',
      url: '/wallets/wlt-1',
      headers: { [IDEMPOTENCY_HEADER]: key },
    });
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(callCount).toBe(1);
  });

  it('rejects a key that is too long with 400', async () => {
    const longKey = 'a'.repeat(256);
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { [IDEMPOTENCY_HEADER]: longKey },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('rejects a key with injection characters with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { [IDEMPOTENCY_HEADER]: 'key\r\nevil' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
