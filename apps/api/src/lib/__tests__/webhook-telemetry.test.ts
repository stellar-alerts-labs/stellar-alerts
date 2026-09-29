/**
 * Tests for the webhook dispatch telemetry surface: span shaping and the
 * process-local Prometheus registry.
 *
 * The span assertions run against a recording fake rather than a real SDK, so
 * they pin the attributes/events we promise to Jaeger without depending on a
 * collector being reachable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  WebhookDispatchMetrics,
  classifyWebhookStatus,
  recordPhaseTimingsOnSpan,
  finalizeWebhookDispatchSpan,
  startWebhookDispatchSpan,
  webhookDispatchMetrics,
  WEBHOOK_DISPATCH_SPAN_NAME,
  type WebhookDispatchOutcome,
} from '../webhook-telemetry';
import type { HttpPhaseDurations } from '../http-phase-timer';

const TIMINGS: HttpPhaseDurations = {
  dnsMs: 5,
  tcpConnectMs: 10,
  tlsHandshakeMs: 20,
  ttfbMs: 40,
  responseStreamMs: 15,
  totalMs: 90,
};

/** Records every span mutation the module makes, keyed by attribute/event name. */
function recordingSpan() {
  const attributes = new Map<string, unknown>();
  const events: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
  const statuses: Array<{ code: SpanStatusCode; message?: string }> = [];
  const exceptions: Error[] = [];
  let ended = false;

  const span = {
    setAttribute(name: string, value: unknown) {
      attributes.set(name, value);
      return span;
    },
    addEvent(name: string, attrs?: Record<string, unknown>) {
      events.push({ name, attributes: attrs });
      return span;
    },
    setStatus(status: { code: SpanStatusCode; message?: string }) {
      statuses.push(status as { code: SpanStatusCode; message?: string });
      return span;
    },
    recordException(error: Error) {
      exceptions.push(error);
    },
    end() {
      ended = true;
    },
    isRecording() {
      return true;
    },
    updateName() {
      return span;
    },
    spanContext() {
      return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 };
    },
  };

  return {
    span: span as unknown as Span,
    attributes,
    events,
    statuses,
    exceptions,
    isEnded: () => ended,
  };
}

let metrics: WebhookDispatchMetrics;

beforeEach(() => {
  metrics = new WebhookDispatchMetrics();
});

describe('classifyWebhookStatus', () => {
  it.each([
    [200, '2xx'],
    [204, '2xx'],
    [299, '2xx'],
    [301, '3xx'],
    [404, '4xx'],
    [429, '4xx'],
    [500, '5xx'],
    [503, '5xx'],
  ])('maps %i to %s', (status, expected) => {
    expect(classifyWebhookStatus(status)).toBe(expected);
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'maps the non-status %s to none',
    (status) => {
      expect(classifyWebhookStatus(status as number)).toBe('none');
    },
  );
});

describe('recordPhaseTimingsOnSpan', () => {
  it('records every observed phase as an attribute and a span event', () => {
    const rec = recordingSpan();
    recordPhaseTimingsOnSpan(rec.span, TIMINGS);

    expect(rec.attributes.get('webhook.duration.total_ms')).toBe(90);
    expect(rec.attributes.get('webhook.phase.dns_ms')).toBe(5);
    expect(rec.attributes.get('webhook.phase.tcp_connect_ms')).toBe(10);
    expect(rec.attributes.get('webhook.phase.tls_handshake_ms')).toBe(20);
    expect(rec.attributes.get('webhook.phase.ttfb_ms')).toBe(40);
    expect(rec.attributes.get('webhook.phase.response_stream_ms')).toBe(15);

    expect(rec.events.map((e) => e.name)).toEqual([
      'dns.lookup',
      'tcp.connect',
      'tls.handshake',
      'http.ttfb',
      'http.response.stream',
    ]);
  });

  it('omits unobserved phases instead of recording them as zero', () => {
    const rec = recordingSpan();
    recordPhaseTimingsOnSpan(rec.span, {
      dnsMs: null,
      tcpConnectMs: null,
      tlsHandshakeMs: null,
      ttfbMs: 12,
      responseStreamMs: 8,
      totalMs: 20,
    });

    // "Reused socket" has to stay distinguishable from "phase took 0ms".
    expect(rec.attributes.has('webhook.phase.dns_ms')).toBe(false);
    expect(rec.attributes.has('webhook.phase.tcp_connect_ms')).toBe(false);
    expect(rec.attributes.has('webhook.phase.tls_handshake_ms')).toBe(false);
    expect(rec.attributes.get('webhook.phase.ttfb_ms')).toBe(12);
    expect(rec.events).toHaveLength(2);
  });
});

describe('finalizeWebhookDispatchSpan', () => {
  it('sets the dispatch attributes a Jaeger query would filter on', () => {
    const rec = recordingSpan();
    finalizeWebhookDispatchSpan(rec.span, {
      webhookId: 'wh_123',
      url: 'https://customer.example.com/hooks/stellar?token=abc',
      method: 'POST',
      status: 204,
      responseBytes: 128,
      attempt: 2,
      timings: TIMINGS,
      outcome: 'delivered',
    });

    expect(rec.attributes.get('webhook.id')).toBe('wh_123');
    expect(rec.attributes.get('url.scheme')).toBe('https');
    expect(rec.attributes.get('server.address')).toBe('customer.example.com');
    expect(rec.attributes.get('url.path')).toBe('/hooks/stellar');
    expect(rec.attributes.get('http.request.method')).toBe('POST');
    expect(rec.attributes.get('http.response.status_code')).toBe(204);
    expect(rec.attributes.get('http.response.body.size')).toBe(128);
    expect(rec.attributes.get('webhook.dispatch.attempt')).toBe(2);
    expect(rec.attributes.get('webhook.dispatch.outcome')).toBe('delivered');
    expect(rec.attributes.get('webhook.response.class')).toBe('2xx');
    expect(rec.statuses).toEqual([{ code: SpanStatusCode.OK }]);
  });

  it('does not leak the webhook secret into span attributes', () => {
    const rec = recordingSpan();
    finalizeWebhookDispatchSpan(rec.span, {
      webhookId: 'wh_123',
      url: 'https://customer.example.com/hooks?token=s3cret',
      method: 'POST',
      status: 200,
      outcome: 'delivered',
    });

    // The query string is deliberately not recorded — customers put signing
    // secrets there and spans go to a third-party collector.
    expect(rec.attributes.has('url.query')).toBe(false);
    expect([...rec.attributes.values()].join(' ')).not.toContain('s3cret');
  });

  it.each<WebhookDispatchOutcome>([
    'rate_limited',
    'server_error',
    'client_error',
    'circuit_open',
    'ssrf_blocked',
  ])('marks a completed-but-failed delivery (%s) as ERROR', (outcome) => {
    const rec = recordingSpan();
    finalizeWebhookDispatchSpan(rec.span, {
      webhookId: 'wh_1',
      url: 'https://example.com/hook',
      method: 'POST',
      status: outcome === 'rate_limited' ? 429 : 500,
      outcome,
    });

    expect(rec.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: outcome }]);
    expect(rec.exceptions).toHaveLength(0);
  });

  it('records a transport error as a span exception', () => {
    const rec = recordingSpan();
    const error = new Error('socket hang up');
    finalizeWebhookDispatchSpan(rec.span, {
      webhookId: 'wh_1',
      url: 'https://example.com/hook',
      method: 'POST',
      status: null,
      outcome: 'connection_error',
      error,
    });

    expect(rec.exceptions).toEqual([error]);
    expect(rec.statuses).toEqual([{ code: SpanStatusCode.ERROR, message: 'socket hang up' }]);
    expect(rec.attributes.get('error.type')).toBe('Error');
    expect(rec.attributes.get('webhook.response.class')).toBe('none');
    // A request that never got a response must not claim a status code.
    expect(rec.attributes.has('http.response.status_code')).toBe(false);
  });
});

describe('startWebhookDispatchSpan', () => {
  it('names the client span used for a delivery attempt', () => {
    const span = startWebhookDispatchSpan();
    expect(span).toBeDefined();
    expect(WEBHOOK_DISPATCH_SPAN_NAME).toBe('webhook.dispatch');
    span.end();
  });
});

describe('WebhookDispatchMetrics', () => {
  it('counts attempts by outcome', () => {
    metrics.record({ timings: TIMINGS, outcome: 'delivered', status: 200 });
    metrics.record({ timings: TIMINGS, outcome: 'delivered', status: 200 });
    metrics.record({ timings: TIMINGS, outcome: 'server_error', status: 503 });

    expect(metrics.attemptsByOutcome()).toMatchObject({
      delivered: 2,
      server_error: 1,
      timeout: 0,
    });
  });

  it('coerces an unknown outcome instead of dropping the observation', () => {
    metrics.record({ timings: null, outcome: 'something_new', status: 200 });
    expect(metrics.attemptsByOutcome().connection_error).toBe(1);
  });

  it('tracks in-flight attempts with a gauge', () => {
    metrics.beginAttempt();
    metrics.beginAttempt();
    expect(metrics.render()).toContain('stellar_alerts_webhook_dispatch_in_flight 2');

    metrics.endAttempt();
    expect(metrics.render()).toContain('stellar_alerts_webhook_dispatch_in_flight 1');
  });

  it('renders only the phases that were actually observed', () => {
    metrics.record({
      timings: { ...TIMINGS, tlsHandshakeMs: null, dnsMs: null, tcpConnectMs: null },
      outcome: 'delivered',
      status: 200,
    });

    const output = metrics.render();
    expect(output).toContain('phase="ttfb"');
    expect(output).toContain('phase="response_stream"');
    // A reused connection must not appear as a zero-duration phase.
    expect(output).not.toContain('phase="tls_handshake"');
    expect(output).not.toContain('phase="dns"');
  });

  it('emits valid Prometheus histogram exposition', () => {
    metrics.record({ timings: TIMINGS, outcome: 'delivered', status: 200 });
    const output = metrics.render();

    expect(output).toContain('# HELP stellar_alerts_webhook_dispatch_phase_duration_seconds');
    expect(output).toContain('# TYPE stellar_alerts_webhook_dispatch_phase_duration_seconds histogram');
    expect(output).toContain('# TYPE stellar_alerts_webhook_dispatch_attempts_total counter');
    expect(output).toContain('# TYPE stellar_alerts_webhook_dispatch_in_flight gauge');

    // Buckets are cumulative, the +Inf bucket equals the observation count.
    // Label keys are sorted alphabetically, so `le` is rendered before `phase`.
    expect(output).toMatch(/le="0.005",phase="ttfb"\} 0/);
    expect(output).toMatch(/le="1",phase="ttfb"\} 1/);
    expect(output).toMatch(/le="\+Inf",phase="ttfb"\} 1/);
    expect(output).toMatch(/phase="ttfb"\} 0\.04/);
    expect(output).toMatch(/outcome="delivered"\} 1/);
  });

  it('ignores non-finite or negative observations', () => {
    metrics.record({
      timings: { ...TIMINGS, ttfbMs: Number.NaN, responseStreamMs: -5 },
      outcome: 'delivered',
      status: 200,
    });

    const output = metrics.render();
    expect(output).not.toContain('phase="ttfb"');
    expect(output).not.toContain('phase="response_stream"');
  });

  it('keeps series cardinality bounded no matter how many distinct deliveries arrive', () => {
    // Webhook ids and URLs are user-controlled and unbounded. They must never
    // become labels, or one tenant could inflate the fleet's series count.
    for (let i = 0; i < 500; i += 1) {
      metrics.record({
        timings: { ...TIMINGS },
        outcome: i % 2 === 0 ? 'delivered' : 'server_error',
        status: i % 2 === 0 ? 200 : 500,
      });
    }

    const output = metrics.render();
    const seriesLines = output
      .split('\n')
      .filter((line) => line && !line.startsWith('#'));

    // 2 outcomes + 2 result classes + 5 phases + 1 gauge, times the bucket fan-out.
    expect(seriesLines.length).toBeLessThan(200);
    expect(metrics.attemptsByOutcome().delivered).toBe(250);
  });

  it('clears all series on reset', () => {
    metrics.record({ timings: TIMINGS, outcome: 'delivered', status: 200 });
    metrics.beginAttempt();
    metrics.reset();

    expect(metrics.attemptsByOutcome().delivered).toBe(0);
    expect(metrics.render()).toContain('stellar_alerts_webhook_dispatch_in_flight 0');
  });
});

describe('singleton registry', () => {
  it('is the instance the dispatcher records into', () => {
    expect(webhookDispatchMetrics).toBeInstanceOf(WebhookDispatchMetrics);
  });
});
