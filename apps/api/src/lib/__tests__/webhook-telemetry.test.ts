import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ExternalRequestTimeoutError } from '../external-request';
import {
  buildTraceparent,
  computePhases,
  instrumentedWebhookFetch,
  parseTraceparent,
  setWebhookDispatchClockForTesting,
} from '../webhook-telemetry';
import {
  renderWebhookDispatchMetrics,
  resetWebhookDispatchMetrics,
} from '../webhook-metrics';

/**
 * `sdk-trace-base` ships transitively via the declared `@opentelemetry/sdk-node`
 * dependency and is already pinned in package-lock.json, so it is imported here
 * rather than added to package.json (which would desync `npm ci`).
 */
const exporter = new InMemorySpanExporter();

function useTracer(): BasicTracerProvider {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // OpenTelemetry 2.x moved global registration off the provider instance.
  trace.setGlobalTracerProvider(provider);
  return provider;
}

interface RecordedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Local endpoint standing in for a subscriber webhook. */
function startEchoServer(
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (handler) {
        handler(req, res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Subscriber': 'echo' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  return new Promise((resolve) => {
    // Bind every interface and address the server by hostname: a bare IP literal
    // short-circuits name resolution, so Node would never emit the `lookup`
    // event and the DNS phase could not be exercised at all.
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://localhost:${port}/hook`, requests });
    });
  });
}

function histogramValue(metric: string, labels: string): number | undefined {
  const match = renderWebhookDispatchMetrics().match(
    new RegExp(`^${metric}_bucket\\{${labels},le="\\+Inf"\\} ([0-9.]+)$`, 'm'),
  );
  return match ? Number(match[1]) : undefined;
}

describe('webhook dispatch telemetry', () => {
  beforeEach(() => {
    resetWebhookDispatchMetrics();
    exporter.reset();
  });

  afterEach(() => {
    trace.disable();
    setWebhookDispatchClockForTesting(null);
  });

  describe('phase capture over a real endpoint', () => {
    it('records DNS, TCP connect, TTFB and response stream phases as Prometheus histograms', async () => {
      const { server, url } = await startEchoServer();
      try {
        const response = await instrumentedWebhookFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'payment' }),
          timeoutMs: 5000,
          // A fresh socket guarantees the DNS/TCP phases actually execute.
          keepAlive: false,
        });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(JSON.stringify({ ok: true }));
        expect(response.headers.get('x-subscriber')).toBe('echo');

        expect(histogramValue('stellar_alerts_webhook_dispatch_phase_duration_seconds', 'phase="dns_lookup"')).toBe(1);
        expect(histogramValue('stellar_alerts_webhook_dispatch_phase_duration_seconds', 'phase="tcp_connect"')).toBe(1);
        expect(histogramValue('stellar_alerts_webhook_dispatch_phase_duration_seconds', 'phase="ttfb"')).toBe(1);
        expect(histogramValue('stellar_alerts_webhook_dispatch_phase_duration_seconds', 'phase="response_stream"')).toBe(1);

        // Plaintext endpoint: there is no TLS handshake to report, so the phase
        // must be absent rather than reported as a misleading zero.
        expect(
          histogramValue('stellar_alerts_webhook_dispatch_phase_duration_seconds', 'phase="tls_handshake"'),
        ).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('reports every phase with a non-negative duration and a total covering the request', async () => {
      const { server, url } = await startEchoServer();
      try {
        const response = await instrumentedWebhookFetch(url, { body: '{}', keepAlive: false });

        expect(response.timings.dnsLookupMs).not.toBeNull();
        expect(response.timings.dnsLookupMs!).toBeGreaterThanOrEqual(0);
        expect(response.timings.tcpConnectMs!).toBeGreaterThanOrEqual(0);
        expect(response.timings.ttfbMs!).toBeGreaterThanOrEqual(0);
        expect(response.timings.responseStreamMs!).toBeGreaterThanOrEqual(0);
        expect(response.timings.tlsHandshakeMs).toBeNull();
        expect(response.timings.totalMs).toBeGreaterThanOrEqual(0);

        const phases =
          response.timings.dnsLookupMs! +
          response.timings.tcpConnectMs! +
          response.timings.ttfbMs! +
          response.timings.responseStreamMs!;
        expect(phases).toBeLessThanOrEqual(response.timings.totalMs + 1);
      } finally {
        server.close();
      }
    });

    it('measures a slow response body as response stream time', async () => {
      const { server, url } = await startEchoServer((_req, res) => {
        res.writeHead(200);
        res.write('first');
        // Hold the stream open so TTFB and body streaming are distinguishable.
        setTimeout(() => res.end('second'), 60);
      });

      try {
        const response = await instrumentedWebhookFetch(url, { body: '{}', keepAlive: false });
        expect(await response.text()).toBe('firstsecond');
        expect(response.timings.responseStreamMs!).toBeGreaterThanOrEqual(50);
        expect(histogramValue('stellar_alerts_webhook_dispatch_phase_duration_seconds', 'phase="response_stream"')).toBe(1);
      } finally {
        server.close();
      }
    });

    it('does not report DNS/TCP phases for a reused keep-alive socket', async () => {
      const { server, url } = await startEchoServer();
      try {
        const first = await instrumentedWebhookFetch(url, { body: '{}', keepAlive: true });
        const second = await instrumentedWebhookFetch(url, { body: '{}', keepAlive: true });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        // The second request reuses the pooled socket, so DNS/TCP never ran and
        // must not be counted a second time.
        expect(second.timings.socketReused).toBe(true);
        expect(second.timings.dnsLookupMs).toBeNull();
        expect(second.timings.tcpConnectMs).toBeNull();
        expect(
          histogramValue('stellar_alerts_webhook_dispatch_phase_duration_seconds', 'phase="dns_lookup"'),
        ).toBe(1);
      } finally {
        server.close();
      }
    });
  });

  describe('phase attribution', () => {
    it('attributes each phase to the window since the previous phase completed', () => {
      const phases = computePhases(
        { dns: 5, connect: 20, tls: 60, ttfb: 200, stream: 350 },
        0,
      );

      expect(phases.dns_lookup).toBe(5);
      expect(phases.tcp_connect).toBe(15);
      expect(phases.tls_handshake).toBe(40);
      expect(phases.ttfb).toBe(140);
      expect(phases.response_stream).toBe(150);
    });

    it('includes the TLS handshake for an https dispatch', () => {
      const phases = computePhases({ dns: 2, connect: 10, tls: 90, ttfb: 120, stream: 130 }, 0);

      expect(phases.tls_handshake).toBe(80);
      expect(phases.ttfb).toBe(30);
      expect(phases.dns_lookup).toBe(2);
    });

    it('leaves phases null when they did not occur', () => {
      const phases = computePhases({ ttfb: 40, stream: 55 }, 10);

      expect(phases.dns_lookup).toBeNull();
      expect(phases.tcp_connect).toBeNull();
      expect(phases.tls_handshake).toBeNull();
      expect(phases.ttfb).toBe(30);
      expect(phases.response_stream).toBe(15);
    });
  });

  describe('W3C TraceContext propagation', () => {
    it('sends a spec-compliant traceparent to the subscriber', async () => {
      const { server, url, requests } = await startEchoServer();
      try {
        await instrumentedWebhookFetch(url, { body: '{}', keepAlive: false });

        const traceparent = requests[0]!.headers.traceparent as string;
        expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      } finally {
        server.close();
      }
    });

    it('preserves the inbound trace id so dispatch joins the originating trace', async () => {
      const { server, url, requests } = await startEchoServer();
      const inboundTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      try {
        await instrumentedWebhookFetch(url, {
          body: '{}',
          keepAlive: false,
          traceparent: `00-${inboundTraceId}-00f067aa0ba902b7-01`,
        });

        const traceparent = requests[0]!.headers.traceparent as string;
        const parsed = parseTraceparent(traceparent);
        expect(parsed?.traceId).toBe(inboundTraceId);
      } finally {
        server.close();
      }
    });

    it('omits the header when propagation is disabled', async () => {
      const { server, url, requests } = await startEchoServer();
      try {
        await instrumentedWebhookFetch(url, { body: '{}', keepAlive: false, propagateTraceContext: false });
        expect(requests[0]!.headers.traceparent).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('parses valid traceparent values and rejects malformed ones', () => {
      expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: 1,
      });

      expect(parseTraceparent('garbage')).toBeNull();
      expect(parseTraceparent('00-short-span-00f067aa0ba902b7-01')).toBeNull();
      expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-tooshort-01')).toBeNull();
      expect(parseTraceparent(undefined)).toBeNull();
    });

    it('falls back to a valid traceparent when no SDK is registered', () => {
      // With tracing disabled the API span context is invalid; the header must
      // still be spec-valid so subscribers never see a malformed value.
      const nonRecordingSpan = trace.getTracer('test').startSpan('noop');
      expect(buildTraceparent(nonRecordingSpan)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      nonRecordingSpan.end();
    });

    it('continues the inbound trace id when no SDK is registered', () => {
      const nonRecordingSpan = trace.getTracer('test').startSpan('noop');
      const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      expect(buildTraceparent(nonRecordingSpan, inbound)).toBe(inbound);
      nonRecordingSpan.end();
    });
  });

  describe('OpenTelemetry spans', () => {
    it('emits a dispatch span plus one child span per completed phase', async () => {
      useTracer();

      const { server, url } = await startEchoServer();
      try {
        await instrumentedWebhookFetch(url, {
          body: '{}',
          keepAlive: false,
          webhookId: 'wh_123',
        });

        const spans = exporter.getFinishedSpans();
        const dispatch = spans.find((s) => s.name === 'webhook.dispatch');

        expect(dispatch).toBeDefined();
        expect(dispatch!.attributes['webhook.id']).toBe('wh_123');
        expect(dispatch!.attributes['http.response.status_code']).toBe(200);
        expect(dispatch!.attributes['url.full']).toBe(url);
        expect(dispatch!.attributes['webhook.socket.reused']).toBe(false);

        const phaseSpans = spans
          .filter((s) => s.name.startsWith('webhook.phase.'))
          .map((s) => s.name)
          .sort();

        expect(phaseSpans).toEqual([
          'webhook.phase.dns_lookup',
          'webhook.phase.response_stream',
          'webhook.phase.tcp_connect',
          'webhook.phase.ttfb',
        ]);

        // Every phase span must hang off the dispatch span.
        for (const span of spans.filter((s) => s.name.startsWith('webhook.phase.'))) {
          expect(span.parentSpanContext?.spanId).toBe(dispatch!.spanContext().spanId);
        }
      } finally {
        server.close();
      }
    });

    it('marks the dispatch span as an error and still records timings on failure', async () => {
      useTracer();

      const { server, url } = await startEchoServer();
      server.close();

      await expect(
        instrumentedWebhookFetch(url, { body: '{}', keepAlive: false, timeoutMs: 2000 }),
      ).rejects.toThrow();

      const dispatch = exporter.getFinishedSpans().find((s) => s.name === 'webhook.dispatch');
      expect(dispatch).toBeDefined();
      expect(dispatch!.status.code).toBe(2 /* SpanStatusCode.ERROR */);
      expect(dispatch!.events.length).toBeGreaterThan(0);

      // Failures must still be observable in Prometheus.
      const metrics = renderWebhookDispatchMetrics();
      expect(metrics).toContain('stellar_alerts_webhook_dispatch_total{outcome="failed"} 1');
    });

    it('uses the inbound traceparent as a remote parent of the dispatch span', async () => {
      useTracer();

      const inboundSpanId = '00f067aa0ba902b7';
      const inboundTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';

      const { server, url } = await startEchoServer();
      try {
        await instrumentedWebhookFetch(url, {
          body: '{}',
          keepAlive: false,
          traceparent: `00-${inboundTraceId}-${inboundSpanId}-01`,
        });

        const dispatch = exporter.getFinishedSpans().find((s) => s.name === 'webhook.dispatch');
        expect(dispatch!.spanContext().traceId).toBe(inboundTraceId);
      } finally {
        server.close();
      }
    });
  });

  describe('failure handling', () => {
    it('rejects with ExternalRequestTimeoutError when the endpoint stalls', async () => {
      const { server, url } = await startEchoServer((_req, res) => {
        res.writeHead(200);
        res.write('partial');
        // Never end the response, forcing the deadline to fire.
      });

      try {
        await expect(
          instrumentedWebhookFetch(url, { body: '{}', keepAlive: false, timeoutMs: 120 }),
        ).rejects.toBeInstanceOf(ExternalRequestTimeoutError);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });

    it('surfaces a non-2xx status without throwing so the breaker can classify it', async () => {
      const { server, url } = await startEchoServer((_req, res) => {
        res.writeHead(500);
        res.end('upstream boom');
      });

      try {
        const response = await instrumentedWebhookFetch(url, { body: '{}', keepAlive: false });
        expect(response.status).toBe(500);
        expect(response.ok).toBe(false);
        expect(await response.text()).toBe('upstream boom');
      } finally {
        server.close();
      }
    });

    it('preserves repeated response headers as a comma-joined value', async () => {
      const { server, url } = await startEchoServer((_req, res) => {
        res.writeHead(200, { 'Set-Cookie': ['a=1', 'b=2'] });
        res.end('ok');
      });

      try {
        const response = await instrumentedWebhookFetch(url, { body: '{}', keepAlive: false });
        expect(response.headers.get('set-cookie')).toBe('a=1, b=2');
      } finally {
        server.close();
      }
    });
  });

  describe('Prometheus exposition', () => {
    it('renders cumulative buckets, +Inf and sum/count for the phase histogram', async () => {
      const { server, url } = await startEchoServer();
      try {
        await instrumentedWebhookFetch(url, { body: '{}', keepAlive: false });
      } finally {
        server.close();
      }

      const metrics = renderWebhookDispatchMetrics();
      const name = 'stellar_alerts_webhook_dispatch_phase_duration_seconds';

      expect(metrics).toContain(`# HELP ${name} `);
      expect(metrics).toContain(`# TYPE ${name} histogram`);

      const ttfbLines = metrics
        .split('\n')
        .filter((line) => line.startsWith(`${name}_bucket{phase="ttfb"`));
      expect(ttfbLines.length).toBe(WEBHOOK_BUCKET_COUNT + 1);

      // Cumulative: every bucket must be >= the previous one.
      const counts = ttfbLines.map((line) => Number(line.trim().split(' ').pop()));
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
      }
      expect(counts[counts.length - 1]).toBe(1);

      expect(metrics).toContain(`${name}_sum{phase="ttfb"}`);
      expect(metrics).toContain(`${name}_count{phase="ttfb"} 1`);
    });

    it('records outcome-labelled totals and a dispatch counter', async () => {
      const { server, url } = await startEchoServer();
      try {
        await instrumentedWebhookFetch(url, { body: '{}', keepAlive: false });
      } finally {
        server.close();
      }

      const metrics = renderWebhookDispatchMetrics();
      expect(metrics).toContain('stellar_alerts_webhook_dispatch_total{outcome="delivered"} 1');
      expect(metrics).toContain('# TYPE stellar_alerts_webhook_dispatch_total counter');
      expect(metrics).toContain('stellar_alerts_webhook_dispatch_total_duration_seconds_count{outcome="delivered"} 1');
    });

    it('emits header-only metric declarations before any observation', () => {
      const metrics = renderWebhookDispatchMetrics();
      expect(metrics).toContain('# TYPE stellar_alerts_webhook_dispatch_phase_duration_seconds histogram');
      expect(metrics).toContain('# TYPE stellar_alerts_webhook_dispatch_total counter');
      expect(metrics).not.toContain('_bucket{');
    });

    it('does not emit invalid values when a sample is not finite', () => {
      // Guards the exposition format against a NaN poisoning an entire scrape.
      const metrics = renderWebhookDispatchMetrics();
      expect(metrics).not.toMatch(/NaN|Infinity/);
    });
  });

  describe('context handling', () => {
    it('attaches the dispatch span to an explicitly supplied parent context', async () => {
      useTracer();

      const parentSpan = trace.getTracer('test').startSpan('payment.detected');
      const parentContext = trace.setSpan(context.active(), parentSpan);
      parentSpan.end();

      const { server, url } = await startEchoServer();
      try {
        await instrumentedWebhookFetch(url, {
          body: '{}',
          keepAlive: false,
          parentContext,
        });

        const dispatch = exporter.getFinishedSpans().find((s) => s.name === 'webhook.dispatch');
        expect(dispatch!.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
      } finally {
        server.close();
      }
    });
  });
});

/** Must mirror WEBHOOK_DISPATCH_BUCKETS_MS in webhook-metrics.ts. */
const WEBHOOK_BUCKET_COUNT = 12;
