/**
 * W3C TraceContext-instrumented outbound webhook transport.
 *
 * The webhook dispatcher needs per-phase latency visibility (DNS lookup, TCP
 * connect, TLS handshake, time-to-first-byte, response body streaming) because
 * a slow subscriber endpoint is one of the hardest delivery problems to diagnose
 * from a queue-level metric alone.
 *
 * Node's global `fetch` (undici) does not surface per-phase timings, so this
 * module issues the request through `node:http` / `node:https`, whose socket
 * and response events map directly onto the phases we need to measure. The
 * returned object is deliberately shaped like the `Response` that
 * `fetchWithTimeout` used to return, so the circuit breaker and logging call
 * sites keep working unchanged.
 *
 * Every dispatch emits:
 *  - one `webhook.dispatch` CLIENT span carrying every phase as an attribute
 *    (searchable in Jaeger), plus one child span per phase for flame graphs;
 *  - Prometheus histograms for each phase and for end-to-end duration.
 *
 * A W3C `traceparent` is always attached to the outbound request so subscriber
 * services can join the trace.
 */

import http from 'node:http';
import https from 'node:https';
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { ExternalRequestTimeoutError, createDeadlineSignal } from './external-request';
import { generateTraceContext } from './tracing';
import {
  recordWebhookDispatchPhase,
  recordWebhookDispatchTotal,
  type WebhookDispatchOutcome,
  type WebhookDispatchPhase,
} from './webhook-metrics';

const TRACER_NAME = 'stellar-alerts.webhook';
const TRACER_VERSION = '1.0.0';

/** W3C TraceContext flags: "01" marks the context as sampled. */
const W3C_SAMPLED = 1;
const W3C_SAMPLED_FLAGS = '01';

/**
 * Monotonic clock expressed on the epoch timeline. `performance.now()` deltas
 * keep durations immune to wall-clock adjustments, while `performance.timeOrigin`
 * rebases them so the same values can be handed straight to OpenTelemetry as
 * span start/end times.
 */
function now(): number {
  return performance.timeOrigin + performance.now();
}

type Clock = () => number;
let clock: Clock = now;

/**
 * Overrides the dispatch clock. Tests use this to make phase attribution
 * deterministic without depending on real network jitter. Pass `null` to
 * restore the default monotonic clock.
 */
export function setWebhookDispatchClockForTesting(next: Clock | null): void {
  clock = next ?? now;
}

/** Per-phase durations in milliseconds. `null` means the phase did not occur. */
export interface WebhookDispatchTimings {
  dnsLookupMs: number | null;
  tcpConnectMs: number | null;
  tlsHandshakeMs: number | null;
  ttfbMs: number | null;
  responseStreamMs: number | null;
  totalMs: number;
  /** True when the request was issued over a pooled keep-alive socket. */
  socketReused: boolean;
}

/** Minimal `Response`-compatible surface used by the dispatcher call sites. */
export interface WebhookHttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text(): Promise<string>;
  timings: WebhookDispatchTimings;
}

export interface WebhookDispatchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Correlates the span with a specific subscriber webhook record. */
  webhookId?: string;
  /**
   * Inbound W3C traceparent to continue, e.g. one carried on the BullMQ job.
   * When supplied it becomes the remote parent of the dispatch span.
   */
  traceparent?: string;
  /** Attach a `traceparent` header to the outbound request. Defaults to true. */
  propagateTraceContext?: boolean;
  /** Explicit parent context; defaults to the active context. */
  parentContext?: Context;
  /** Reuse pooled sockets. Defaults to true. */
  keepAlive?: boolean;
}

const agents = new Map<string, http.Agent | https.Agent>();

function agentFor(isHttps: boolean, keepAlive: boolean): http.Agent | https.Agent {
  if (!keepAlive) {
    return isHttps
      ? new https.Agent({ keepAlive: false })
      : new http.Agent({ keepAlive: false });
  }

  const key = isHttps ? 'https' : 'http';
  let agent = agents.get(key);
  if (!agent) {
    // A small pool: webhook fan-out is bursty across many subscriber hosts, so
    // unbounded pooling would hold idle sockets open indefinitely.
    agent = isHttps
      ? new https.Agent({ keepAlive: true, maxSockets: 64, timeout: 30_000 })
      : new http.Agent({ keepAlive: true, maxSockets: 64, timeout: 30_000 });
    agents.set(key, agent);
  }
  return agent;
}

interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

/** Parses a W3C `00-<trace>-<span>-<flags>` traceparent, or null when malformed. */
export function parseTraceparent(traceparent: string | undefined): ParsedTraceparent | null {
  if (!traceparent) return null;

  const parts = traceparent.trim().split('-');
  if (parts.length < 4) return null;

  const [, traceId, spanId, flags] = parts;
  if (!traceId || !spanId) return null;
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return null;
  if (!/^[0-9a-f]{16}$/i.test(spanId)) return null;

  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    // Bit 0 of the flags field marks the context as sampled.
    traceFlags: (flags ?? '').toLowerCase() === W3C_SAMPLED_FLAGS ? W3C_SAMPLED : 0,
  };
}

/**
 * Builds the `traceparent` header for the dispatch span, continuing an inbound
 * trace when one was supplied and otherwise falling back to a fresh root context
 * so subscribers always receive a valid header.
 */
export function buildTraceparent(span: Span, inboundTraceparent?: string): string {
  const spanContext = span.spanContext();
  if (!trace.isSpanContextValid(spanContext)) {
    // No SDK registered (unit tests, or telemetry disabled). Continue the
    // inbound trace if there is one, else start a fresh root via the repo's own
    // W3C generator, so the header is always spec-valid.
    const inbound = parseTraceparent(inboundTraceparent);
    return inbound
      ? `00-${inbound.traceId}-${inbound.spanId}-${W3C_SAMPLED_FLAGS}`
      : generateTraceContext().traceparent;
  }

  return `00-${spanContext.traceId}-${spanContext.spanId}-${W3C_SAMPLED_FLAGS}`;
}

/**
 * Establishes the base context for the dispatch. An inbound traceparent is
 * attached as a *remote* parent so the dispatch continues the caller's trace
 * across the queue boundary rather than starting a disconnected trace.
 */
function resolveBaseContext(options: WebhookDispatchOptions): Context {
  const base = options.parentContext ?? otelContext.active();
  const inbound = parseTraceparent(options.traceparent);
  if (!inbound) return base;

  return trace.setSpanContext(base, { ...inbound, isRemote: true });
}

/** Absolute timestamps at which each phase completed. */
export interface PhaseMarks {
  dns?: number;
  connect?: number;
  tls?: number;
  ttfb?: number;
  stream?: number;
}

/**
 * Converts absolute phase marks into per-phase durations. Each phase is measured
 * from the completion of the previous one, so the sum approximates total latency
 * and no phase double-counts another's time. Phases that never ran (TLS on a
 * plaintext endpoint, or DNS/connect/TLS on a reused socket) stay `null` so the
 * `phase` label remains a truthful description of work performed.
 *
 * Exported for deterministic unit testing of the attribution rules.
 */
export function computePhases(
  marks: PhaseMarks,
  startAt: number,
): Record<WebhookDispatchPhase, number | null> {
  const requestStart = marks.tls ?? marks.connect ?? startAt;
  return {
    dns_lookup: marks.dns !== undefined ? marks.dns - startAt : null,
    tcp_connect: marks.connect !== undefined ? marks.connect - (marks.dns ?? startAt) : null,
    tls_handshake: marks.tls !== undefined ? marks.tls - (marks.connect ?? startAt) : null,
    ttfb: marks.ttfb !== undefined ? marks.ttfb - requestStart : null,
    response_stream: marks.stream !== undefined ? marks.stream - (marks.ttfb ?? requestStart) : null,
  };
}

/**
 * Emits a child span for a phase using explicit start/end times. Phases are
 * discovered as the request progresses but only rendered once it settles, so
 * retrospective spans are used rather than interleaved ones.
 */
function emitPhaseSpan(
  tracer: Tracer,
  parentContext: Context,
  phase: WebhookDispatchPhase,
  durationMs: number,
  attributes: Record<string, string | number | boolean>,
): void {
  const endTime = Date.now();
  const span = tracer.startSpan(
    `webhook.phase.${phase}`,
    {
      kind: SpanKind.INTERNAL,
      startTime: endTime - durationMs,
      attributes: { ...attributes, 'webhook.phase': phase },
    },
    parentContext,
  );
  span.setAttribute('webhook.phase.duration_ms', durationMs);
  span.end(endTime);
}

/**
 * Issues a single instrumented webhook request, recording every phase as both an
 * OpenTelemetry span and a Prometheus histogram sample.
 *
 * Rejects with `ExternalRequestTimeoutError` when the deadline elapses, matching
 * the behaviour the dispatcher previously relied on from `fetchWithTimeout`.
 */
export async function instrumentedWebhookFetch(
  url: string,
  options: WebhookDispatchOptions = {},
): Promise<WebhookHttpResponse> {
  const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const timeoutMs = options.timeoutMs ?? 10_000;

  const baseContext = resolveBaseContext(options);
  const dispatchSpan = tracer.startSpan(
    'webhook.dispatch',
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.request.method': options.method ?? 'POST',
        'url.full': url,
        'server.address': target.hostname,
        'server.port': Number(target.port || (isHttps ? 443 : 80)),
        ...(options.webhookId ? { 'webhook.id': options.webhookId } : {}),
      },
    },
    baseContext,
  );
  const dispatchContext = trace.setSpan(baseContext, dispatchSpan);

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.propagateTraceContext !== false) {
    headers.traceparent = buildTraceparent(dispatchSpan, options.traceparent);
  }

  return await new Promise<WebhookHttpResponse>((resolve, reject) => {
    const startAt = clock();
    const marks: PhaseMarks = {};
    let socketReused = false;
    let settled = false;
    let request: http.ClientRequest | undefined;

    const { signal, cleanup, isTimedOut } = createDeadlineSignal(timeoutMs);

    const timings = (): WebhookDispatchTimings => {
      const phases = computePhases(marks, startAt);
      return {
        dnsLookupMs: phases.dns_lookup,
        tcpConnectMs: phases.tcp_connect,
        tlsHandshakeMs: phases.tls_handshake,
        ttfbMs: phases.ttfb,
        responseStreamMs: phases.response_stream,
        totalMs: clock() - startAt,
        socketReused,
      };
    };

    /**
     * Records every completed phase and closes the dispatch span. Guarded by
     * `settled` so the timeout path and the response path cannot both report.
     */
    const finish = (outcome: WebhookDispatchOutcome, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();

      const phases = computePhases(marks, startAt);

      for (const phase of Object.keys(phases) as WebhookDispatchPhase[]) {
        const durationMs = phases[phase];
        if (durationMs === null) continue;
        recordWebhookDispatchPhase(phase, durationMs);
        emitPhaseSpan(tracer, dispatchContext, phase, durationMs, {
          'webhook.socket.reused': socketReused,
        });
      }

      recordWebhookDispatchTotal(clock() - startAt, outcome);

      dispatchSpan.setAttribute('webhook.socket.reused', socketReused);
      dispatchSpan.setAttribute('webhook.dispatch.total_ms', clock() - startAt);
      dispatchSpan.setAttribute('webhook.dns_lookup.duration_ms', phases.dns_lookup ?? 0);
      dispatchSpan.setAttribute('webhook.tcp_connect.duration_ms', phases.tcp_connect ?? 0);
      dispatchSpan.setAttribute('webhook.tls_handshake.duration_ms', phases.tls_handshake ?? 0);
      dispatchSpan.setAttribute('webhook.ttfb.duration_ms', phases.ttfb ?? 0);
      dispatchSpan.setAttribute('webhook.response_stream.duration_ms', phases.response_stream ?? 0);

      if (error) {
        dispatchSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        dispatchSpan.recordException(error);
      } else {
        dispatchSpan.setStatus({ code: SpanStatusCode.OK });
      }
      dispatchSpan.end();
    };

    const onAbort = () => {
      // Destroying with the timeout error routes the rejection through the
      // single `error` handler below, so there is one failure path, not two.
      request?.destroy(
        new ExternalRequestTimeoutError(
          `Request to Webhook (${url}) timed out after ${timeoutMs}ms`,
          { provider: 'Webhook', timeoutMs, url },
        ),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });

    request = (isHttps ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'POST',
        headers,
        agent: agentFor(isHttps, options.keepAlive !== false),
      },
      (res) => {
        marks.ttfb = clock();

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (err) => {
          if (settled) return;
          const error = err as Error;
          finish(
            'failed',
            isTimedOut()
              ? new ExternalRequestTimeoutError(
                  `Request to Webhook (${url}) timed out after ${timeoutMs}ms`,
                  { provider: 'Webhook', timeoutMs, url },
                )
              : error,
          );
          reject(error);
        });
        res.on('end', () => {
          marks.stream = clock();

          const body = Buffer.concat(chunks).toString('utf8');
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(key, item);
            } else {
              responseHeaders.set(key, value);
            }
          }

          const status = res.statusCode ?? 0;
          dispatchSpan.setAttribute('http.response.status_code', status);
          finish('delivered');

          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: responseHeaders,
            text: async () => body,
            timings: timings(),
          });
        });
      },
    );

    request.on('socket', (socket) => {
      // A pooled socket skips DNS/TCP/TLS entirely; record that fact rather than
      // reporting misleading near-zero timings for work that never happened.
      // Node exposes reuse on the request (`reusedSocket`), falling back to the
      // socket's own flag on older runtimes.
      socketReused = Boolean(
        (request as unknown as { reusedSocket?: boolean } | undefined)?.reusedSocket ??
          (socket as { reused?: boolean }).reused,
      );

      socket.on('lookup', () => {
        marks.dns = clock();
      });
      socket.on('connect', () => {
        marks.connect = clock();
      });
      socket.on('secureConnect', () => {
        marks.tls = clock();
      });
    });

    request.on('error', (err) => {
      if (settled) return;
      const error = err as Error;

      finish(
        'failed',
        isTimedOut()
          ? new ExternalRequestTimeoutError(
              `Request to Webhook (${url}) timed out after ${timeoutMs}ms`,
              { provider: 'Webhook', timeoutMs, url },
            )
          : error,
      );

      reject(error);
    });

    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}
