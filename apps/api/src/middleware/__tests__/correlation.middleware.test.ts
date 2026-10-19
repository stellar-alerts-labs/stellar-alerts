import { describe, it, expect, beforeAll, vi } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'stream';
import { registerCorrelation, REQUEST_ID_HEADER } from '../correlation.middleware';
import { getCorrelationId, runWithCorrelationId } from '../../lib/correlation-context';
import { createLogger } from '../../lib/logger';
import { fetchWithTimeout } from '../../lib/external-request';

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await registerCorrelation(app);

  app.get('/ping', async (req) => ({ requestId: req.requestId, reqId: req.reqId }));

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

  it('attaches the requestId and reqId to the request object', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const body = JSON.parse(res.body);
    expect(body.requestId).toBeDefined();
    expect(body.reqId).toBe(body.requestId);
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

  it('captures reqId in structured Fastify logs and propagates to correlation context', async () => {
    const logEntries: any[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        try {
          logEntries.push(JSON.parse(chunk.toString()));
        } catch {
          // ignore non-json
        }
        callback();
      },
    });

    const loggingApp = Fastify({
      logger: {
        stream,
      },
      requestIdLogLabel: 'reqId',
      requestIdHeader: 'x-request-id',
    });

    await registerCorrelation(loggingApp);

    let capturedContextId: string | undefined;

    loggingApp.get('/test-logging', async (req) => {
      capturedContextId = getCorrelationId();
      req.log.info({ test: true }, 'test log message');
      return { ok: true, reqId: req.reqId };
    });

    await loggingApp.ready();

    const customId = 'test-req-id-999';
    const res = await loggingApp.inject({
      method: 'GET',
      url: '/test-logging',
      headers: { 'x-request-id': customId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe(customId);
    expect(capturedContextId).toBe(customId);

    // Verify logs contain reqId matching HTTP header
    const matchingLogs = logEntries.filter((log) => log.reqId === customId);
    expect(matchingLogs.length).toBeGreaterThanOrEqual(1);

    await loggingApp.close();
  });

  it('inherits correlation ID in createLogger when in AsyncLocalStorage context', () => {
    runWithCorrelationId('async-ctx-id-456', () => {
      const logger = createLogger({ module: 'TestWorker' });
      const bindings = (logger as any).bindings ? (logger as any).bindings() : {};
      expect(bindings.reqId ?? (logger as any).fields?.reqId).toBe('async-ctx-id-456');
    });
  });

  it('propagates x-request-id to downstream requests via fetchWithTimeout', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    try {
      await runWithCorrelationId('downstream-trace-789', async () => {
        await fetchWithTimeout('https://horizon.stellar.org/fee_stats');
      });

      expect(fetchSpy).toHaveBeenCalled();
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      const headers = new Headers((lastCall[1] as RequestInit)?.headers);
      expect(headers.get('x-request-id')).toBe('downstream-trace-789');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

