/**
 * Tests for the worker scrape endpoint.
 *
 * The dispatcher runs as its own process, so these are the tests that prove the
 * webhook series it records are actually reachable by Prometheus rather than
 * only living in a worker's memory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { env } from '../../config/env';
import {
  isWorkerMetricsEnabled,
  startWorkerMetricsServer,
  stopWorkerMetricsServer,
} from '../worker-metrics-server';
import { webhookDispatchMetrics } from '../webhook-telemetry';

const originalEnabled = env.WORKER_METRICS_ENABLED;
const originalPort = env.WORKER_METRICS_PORT;

async function get(port: number, path: string): Promise<{ status: number; body: string; contentType: string | undefined }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get('content-type') ?? undefined,
  };
}

beforeEach(() => {
  // Port 0 lets the OS pick a free port, so the suite never collides with a
  // developer already running a worker on 3002.
  env.WORKER_METRICS_ENABLED = 'true';
  env.WORKER_METRICS_PORT = 0;
});

afterEach(async () => {
  await stopWorkerMetricsServer();
  env.WORKER_METRICS_ENABLED = originalEnabled;
  env.WORKER_METRICS_PORT = originalPort;
});

async function startedPort(): Promise<number> {
  const server = startWorkerMetricsServer();
  expect(server).not.toBeNull();
  const address = server!.address() as AddressInfo;
  return address.port;
}

describe('isWorkerMetricsEnabled', () => {
  it('is off by default so an idle worker does not open a listener', () => {
    env.WORKER_METRICS_ENABLED = originalEnabled;
    expect(isWorkerMetricsEnabled()).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE'])('treats %s as enabled', (value) => {
    env.WORKER_METRICS_ENABLED = value;
    expect(isWorkerMetricsEnabled()).toBe(true);
  });

  it.each(['false', '0', 'no', '', 'maybe'])('treats %s as disabled', (value) => {
    env.WORKER_METRICS_ENABLED = value;
    expect(isWorkerMetricsEnabled()).toBe(false);
  });
});

describe('startWorkerMetricsServer', () => {
  it('does nothing when disabled', async () => {
    env.WORKER_METRICS_ENABLED = 'false';
    expect(startWorkerMetricsServer()).toBeNull();
  });

  it('is safe to call twice and returns the same server', async () => {
    const first = startWorkerMetricsServer();
    const second = startWorkerMetricsServer();
    expect(first).toBe(second);
  });

  it('serves the webhook dispatch registry on /metrics', async () => {
    webhookDispatchMetrics.record({
      timings: {
        dnsMs: 3,
        tcpConnectMs: 4,
        tlsHandshakeMs: 5,
        ttfbMs: 6,
        responseStreamMs: 2,
        totalMs: 20,
      },
      outcome: 'delivered',
      status: 200,
    });

    const port = await startedPort();
    const { status, body, contentType } = await get(port, '/metrics');

    expect(status).toBe(200);
    expect(contentType).toContain('text/plain');
    expect(body).toContain('stellar_alerts_webhook_dispatch_attempts_total');
    expect(body).toContain('outcome="delivered"');
    expect(body).toContain('stellar_alerts_webhook_dispatch_phase_duration_seconds');
  });

  it('serves the registry on / as well, for a bare scrape target', async () => {
    const port = await startedPort();
    const { status, body } = await get(port, '/');
    expect(status).toBe(200);
    expect(body).toContain('stellar_alerts_webhook_dispatch_in_flight');
  });

  it('ignores a query string on the scrape path', async () => {
    const port = await startedPort();
    const { status } = await get(port, '/metrics?collect=all');
    expect(status).toBe(200);
  });

  it('answers /healthz with JSON', async () => {
    const port = await startedPort();
    const { status, body, contentType } = await get(port, '/healthz');

    expect(status).toBe(200);
    expect(contentType).toContain('application/json');
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
  });

  it('404s an unknown path', async () => {
    const port = await startedPort();
    const { status, body } = await get(port, '/nope');

    expect(status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: 'not_found' });
  });
});

describe('stopWorkerMetricsServer', () => {
  it('is a no-op when nothing was started', async () => {
    await expect(stopWorkerMetricsServer()).resolves.toBeUndefined();
  });

  it('releases the port so a later start binds successfully', async () => {
    const firstPort = await startedPort();
    await stopWorkerMetricsServer();

    env.WORKER_METRICS_PORT = firstPort;
    const server = startWorkerMetricsServer();
    expect(server).not.toBeNull();

    // Binding the same port again would emit EADDRINUSE if the first close
    // had not completed.
    const { status } = await get(firstPort, '/healthz');
    expect(status).toBe(200);
  });

  it('leaves the endpoint unreachable after shutdown', async () => {
    const port = await startedPort();
    await stopWorkerMetricsServer();
    await expect(get(port, '/metrics')).rejects.toThrow();
  });
});
