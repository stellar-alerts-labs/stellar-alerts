import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import metricsPlugin, { generatePrometheusMetrics } from '../plugins/metrics';
import {
  recordWebhookDispatchPhase,
  recordWebhookDispatchTotal,
  resetWebhookDispatchMetrics,
} from '../lib/webhook-metrics';
import {
  startWorkerMetricsServer,
  stopWorkerMetricsServer,
} from '../lib/worker-metrics-server';

describe('webhook dispatch metric exposition', () => {
  beforeEach(() => {
    resetWebhookDispatchMetrics();
  });

  afterEach(async () => {
    await stopWorkerMetricsServer();
    resetWebhookDispatchMetrics();
  });

  it('appends webhook dispatch histograms to the API /metrics payload', async () => {
    recordWebhookDispatchPhase('ttfb', 120);
    recordWebhookDispatchTotal(140, 'delivered');

    const app = Fastify();
    await app.register(metricsPlugin);

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');

    // Pre-existing queue metrics must remain intact for current consumers.
    expect(response.body).toContain('stellar_alerts_queue_waiting_jobs');
    expect(response.body).toContain('stellar_alerts_worker_processing_latency_ms');

    expect(response.body).toContain('stellar_alerts_webhook_dispatch_phase_duration_seconds_bucket{phase="ttfb",le="+Inf"} 1');
    expect(response.body).toContain('stellar_alerts_webhook_dispatch_total{outcome="delivered"} 1');

    await app.close();
  });

  it('emits every phase as a single-brace histogram bucket with a cumulative ladder', () => {
    recordWebhookDispatchPhase('dns_lookup', 3);
    recordWebhookDispatchPhase('tcp_connect', 40);
    recordWebhookDispatchPhase('tls_handshake', 300);
    recordWebhookDispatchPhase('ttfb', 1200);
    recordWebhookDispatchPhase('response_stream', 90);

    const text = generatePrometheusMetrics();
    const name = 'stellar_alerts_webhook_dispatch_phase_duration_seconds';

    // A bucket label set must be one brace group; two groups is unparseable.
    expect(text).not.toMatch(new RegExp(`${name}_bucket\\{[^}]*\\}\\{`));

    // Values are milliseconds but the metric is declared in seconds, so every
    // observation must land in a bucket no larger than itself.
    const ttfbBuckets = text
      .split('\n')
      .filter((line) => line.startsWith(`${name}_bucket{phase="ttfb"`))
      .map((line) => {
        const bound = line.match(/le="([^"]+)"/)![1];
        return { bound, count: Number(line.trim().split(' ').pop()) };
      });

    // 1200ms must not be counted in any bucket below 1000ms.
    const below1s = ttfbBuckets.find((b) => b.bound === '1000')!;
    expect(below1s.count).toBe(0);

    const atOrAbove = ttfbBuckets.find((b) => b.bound === '2500')!;
    expect(atOrAbove.count).toBe(1);

    for (const phase of ['dns_lookup', 'tcp_connect', 'tls_handshake', 'ttfb', 'response_stream']) {
      expect(text).toContain(`${name}_count{phase="${phase}"} 1`);
      expect(text).toContain(`${name}_sum{phase="${phase}"}`);
    }
  });

  it('serves the worker scrape endpoint in Prometheus text format', async () => {
    recordWebhookDispatchPhase('ttfb', 250);
    recordWebhookDispatchTotal(300, 'delivered');

    // Port 0 asks the OS for a free port, so the test never collides with a
    // real worker or a parallel suite.
    const server = await startWorkerMetricsServer(0);
    const address = server!.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const body = await response.text();
    expect(body).toContain('# TYPE stellar_alerts_webhook_dispatch_phase_duration_seconds histogram');
    expect(body).toContain('phase="ttfb",le="+Inf"} 1');
    expect(body).toContain('stellar_alerts_webhook_dispatch_total{outcome="delivered"} 1');
  });

  it('returns 404 for non-metrics paths on the worker endpoint', async () => {
    const server = await startWorkerMetricsServer(0);
    const address = server!.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(404);
  });

  it('opens no listener when no port is configured', async () => {
    // Telemetry must stay entirely opt-in: an unset WORKER_METRICS_PORT means
    // worker startup behaves exactly as it did before this feature.
    expect(await startWorkerMetricsServer(undefined)).toBeUndefined();
  });
});
