import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import { registerCorrelation } from '../correlation.middleware';

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await registerCorrelation(app);

  app.get('/ping', async (req) => ({ requestId: req.requestId }));

  await app.ready();
  return app;
}

describe('Correlation middleware (X-Request-ID)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  it('generates a request ID when none is provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const id = res.headers['x-request-id'];
    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
    expect((id as string).length).toBeGreaterThan(0);
  });

  it('echoes a valid client-supplied X-Request-ID', async () => {
    const clientId = 'my-correlation-id-123';
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { 'x-request-id': clientId },
    });
    expect(res.headers['x-request-id']).toBe(clientId);
  });

  it('generates a new ID when the supplied header fails validation (too long)', async () => {
    const badId = 'a'.repeat(200); // exceeds 128-char limit
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { 'x-request-id': badId },
    });
    // The echoed ID should NOT equal the bad input — a fresh UUID was generated.
    expect(res.headers['x-request-id']).not.toBe(badId);
    expect((res.headers['x-request-id'] as string).length).toBeLessThanOrEqual(128);
  });

  it('generates a new ID when the supplied header contains unsafe characters', async () => {
    const injectionAttempt = 'id\r\nX-Evil: injected';
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { 'x-request-id': injectionAttempt },
    });
    const returned = res.headers['x-request-id'] as string;
    expect(returned).not.toContain('\r');
    expect(returned).not.toContain('\n');
    expect(returned).not.toBe(injectionAttempt);
  });

  it('attaches the requestId to the request object', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const body = JSON.parse(res.body);
    expect(body.requestId).toBeDefined();
    // Must match the echo in the response header.
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });

  it('generates different IDs for different requests', async () => {
    const [res1, res2] = await Promise.all([
      app.inject({ method: 'GET', url: '/ping' }),
      app.inject({ method: 'GET', url: '/ping' }),
    ]);
    expect(res1.headers['x-request-id']).not.toBe(res2.headers['x-request-id']);
  });
});
