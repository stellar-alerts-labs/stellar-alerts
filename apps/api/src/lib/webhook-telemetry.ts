/**
 * Telemetry surface for webhook dispatch: OpenTelemetry spans (exported over
 * OTLP to Jaeger) plus Prometheus metrics (exported on `/metrics`).
 *
 * Prometheus series are deliberately keyed only on bounded, enumerated labels
 * (`phase`, `outcome`, `result`). Webhook URLs, hostnames and webhook ids are
 * **not** labels: they are attacker/user-controlled and unbounded, so keying on
 * them would let a single tenant blow up the metrics cardinality of the whole
 * fleet. Those values ride on the span instead, where they are per-trace and
 * cost nothing when nobody is looking.
 */
import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import {
  HTTP_PHASE_DNS,
  HTTP_PHASE_RESPONSE_STREAM,
  HTTP_PHASE_TCP_CONNECT,
  HTTP_PHASE_TLS_HANDSHAKE,
  HTTP_PHASE_TTFB,
  type HttpPhaseDurations,
  type HttpPhaseName,
} from './http-phase-timer';

export const WEBHOOK_TRACER_NAME = 'stellar-alerts.webhook-dispatcher';
export const WEBHOOK_DISPATCH_SPAN_NAME = 'webhook.dispatch';

export const webhookTracer = trace.getTracer(WEBHOOK_TRACER_NAME);

/**
 * Terminal classification of a single webhook HTTP attempt. Bounded on purpose —
 * this is a Prometheus label.
 */
export type WebhookDispatchOutcome =
  | 'delivered'
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'timeout'
  | 'connection_error'
  | 'circuit_open'
  | 'ssrf_blocked';

const OUTCOMES: readonly WebhookDispatchOutcome[] = [
  'delivered',
  'rate_limited',
  'server_error',
  'client_error',
  'timeout',
  'connection_error',
  'circuit_open',
  'ssrf_blocked',
];

function isWebhookDispatchOutcome(value: string): value is WebhookDispatchOutcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

/** Coarse 2xx/3xx/4xx/5xx class, used to keep label cardinality flat. */
export type WebhookResultClass = '2xx' | '3xx' | '4xx' | '5xx' | 'none';

export function classifyWebhookStatus(status: number | null | undefined): WebhookResultClass {
  if (status === null || status === undefined || !Number.isFinite(status)) return 'none';
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'none';
}

const PREFIX = 'stellar_alerts_webhook_dispatch';

/**
 * Prometheus histogram buckets in seconds. Dense in the sub-100ms region where
 * healthy webhook endpoints live, with a long tail so a genuinely slow customer
 * endpoint still lands in a bucket rather than `+Inf` by default.
 */
const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

/**
 * Guards against a label set we did not anticipate turning into unbounded
 * cardinality. Real label values come from fixed enums, so this only trips if a
 * caller starts passing user-controlled data through.
 */
const MAX_LABEL_VALUES_PER_NAME = 64;

function formatLabelSet(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${labels[k].replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : (value < 0 ? '-Inf' : 'NaN');
  return Number.isInteger(value) ? value.toString() : value.toFixed(6).replace(/0+$/, '');
}

class Histogram {
  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly labelName: string,
    private readonly buckets: number[] = LATENCY_BUCKETS_SECONDS,
  ) {}

  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  private readonly seenLabelValues = new Set<string>();

  observe(labelValue: string, valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;

    if (!this.seenLabelValues.has(labelValue)) {
      if (this.seenLabelValues.size >= MAX_LABEL_VALUES_PER_NAME) return;
      this.seenLabelValues.add(labelValue);
    }

    const key = labelValue;
    let series = this.series.get(key);
    if (!series) {
      series = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, series);
    }

    const seconds = valueMs / 1000;
    series.sum += seconds;
    series.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (seconds <= this.buckets[i]) series.counts[i] += 1;
    }
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const [labelValue, series] of [...this.series.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const labels = formatLabelSet({ [this.labelName]: labelValue });
      for (let i = 0; i < this.buckets.length; i += 1) {
        // `counts[i]` is already cumulative: `observe` increments every bucket
        // from the smallest up to the one the sample falls into.
        const bucketLabels = formatLabelSet({ [this.labelName]: labelValue, le: String(this.buckets[i]) });
        lines.push(`${this.name}_bucket${bucketLabels} ${series.counts[i]}`);
      }
      lines.push(`${this.name}_bucket${formatLabelSet({ [this.labelName]: labelValue, le: '+Inf' })} ${series.count}`);
      lines.push(`${this.name}_sum${labels} ${formatFloat(series.sum)}`);
      lines.push(`${this.name}_count${labels} ${series.count}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.series.clear();
    this.seenLabelValues.clear();
  }
}

class LabelCounter {
  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly labelName: string,
  ) {}

  private readonly series = new Map<string, number>();
  private readonly seenLabelValues = new Set<string>();

  inc(labelValue: string, by = 1): void {
    if (!Number.isFinite(by)) return;
    if (!this.seenLabelValues.has(labelValue)) {
      if (this.seenLabelValues.size >= MAX_LABEL_VALUES_PER_NAME) return;
      this.seenLabelValues.add(labelValue);
    }
    this.series.set(labelValue, (this.series.get(labelValue) ?? 0) + by);
  }

  get(labelValue: string): number {
    return this.series.get(labelValue) ?? 0;
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const [labelValue, value] of [...this.series.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${this.name}${formatLabelSet({ [this.labelName]: labelValue })} ${formatFloat(value)}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.series.clear();
    this.seenLabelValues.clear();
  }
}

class Gauge {
  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  private value = 0;

  set(next: number): void {
    if (Number.isFinite(next)) this.value = next;
  }

  inc(by = 1): void {
    this.set(this.value + by);
  }

  dec(by = 1): void {
    this.set(this.value - by);
  }

  render(): string {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${formatFloat(this.value)}`].join('\n');
  }

  reset(): void {
    this.value = 0;
  }
}

const PHASE_ATTRIBUTE: Record<HttpPhaseName, string> = {
  [HTTP_PHASE_DNS]: 'webhook.phase.dns_ms',
  [HTTP_PHASE_TCP_CONNECT]: 'webhook.phase.tcp_connect_ms',
  [HTTP_PHASE_TLS_HANDSHAKE]: 'webhook.phase.tls_handshake_ms',
  [HTTP_PHASE_TTFB]: 'webhook.phase.ttfb_ms',
  [HTTP_PHASE_RESPONSE_STREAM]: 'webhook.phase.response_stream_ms',
};

/** Span event name per phase, so Jaeger renders a readable waterfall. */
const PHASE_EVENT: Record<HttpPhaseName, string> = {
  [HTTP_PHASE_DNS]: 'dns.lookup',
  [HTTP_PHASE_TCP_CONNECT]: 'tcp.connect',
  [HTTP_PHASE_TLS_HANDSHAKE]: 'tls.handshake',
  [HTTP_PHASE_TTFB]: 'http.ttfb',
  [HTTP_PHASE_RESPONSE_STREAM]: 'http.response.stream',
};

function phaseValue(timings: HttpPhaseDurations, phase: HttpPhaseName): number | null {
  switch (phase) {
    case HTTP_PHASE_DNS:
      return timings.dnsMs;
    case HTTP_PHASE_TCP_CONNECT:
      return timings.tcpConnectMs;
    case HTTP_PHASE_TLS_HANDSHAKE:
      return timings.tlsHandshakeMs;
    case HTTP_PHASE_TTFB:
      return timings.ttfbMs;
    case HTTP_PHASE_RESPONSE_STREAM:
      return timings.responseStreamMs;
    default:
      return null;
  }
}

/**
 * Writes the measured phases onto a span as both attributes (for querying and
 * alerting) and span events (for the Jaeger waterfall).
 *
 * Only observed phases are emitted. A `null` duration is skipped rather than
 * recorded as `0`, so "connection reused" stays distinguishable from "phase was
 * instantaneous" in the trace.
 */
export function recordPhaseTimingsOnSpan(span: Span, timings: HttpPhaseDurations): void {
  span.setAttribute('webhook.duration.total_ms', timings.totalMs);

  for (const phase of Object.keys(PHASE_ATTRIBUTE) as HttpPhaseName[]) {
    const value = phaseValue(timings, phase);
    if (value === null) continue;
    span.setAttribute(PHASE_ATTRIBUTE[phase], value);
    span.addEvent(PHASE_EVENT[phase], { 'duration.ms': value });
  }
}

export interface WebhookDispatchSpanInput {
  webhookId: string;
  url: string;
  method: string;
  status?: number | null;
  responseBytes?: number | null;
  attempt?: number | null;
  timings?: HttpPhaseDurations | null;
  outcome: WebhookDispatchOutcome;
  error?: Error | null;
}

function splitUrl(url: string): { scheme?: string; host?: string; path?: string } {
  try {
    const parsed = new URL(url);
    return { scheme: parsed.protocol.replace(':', ''), host: parsed.host, path: parsed.pathname };
  } catch {
    return {};
  }
}

/**
 * Applies the terminal result of a dispatch attempt to its span: status,
 * outcome, and either `OK` or `ERROR`. Errors are also recorded as span
 * exceptions so Jaeger's error badge and the exception tab both work.
 */
export function finalizeWebhookDispatchSpan(span: Span, input: WebhookDispatchSpanInput): void {
  const { scheme, host, path } = splitUrl(input.url);
  if (scheme) span.setAttribute('url.scheme', scheme);
  if (host) span.setAttribute('server.address', host);
  if (path) span.setAttribute('url.path', path);
  span.setAttribute('http.request.method', input.method);
  span.setAttribute('webhook.id', input.webhookId);
  span.setAttribute('webhook.dispatch.outcome', input.outcome);
  span.setAttribute('webhook.response.class', classifyWebhookStatus(input.status));
  if (typeof input.status === 'number') {
    span.setAttribute('http.response.status_code', input.status);
  }
  if (typeof input.responseBytes === 'number') {
    span.setAttribute('http.response.body.size', input.responseBytes);
  }
  if (typeof input.attempt === 'number') {
    span.setAttribute('webhook.dispatch.attempt', input.attempt);
  }
  if (input.timings) {
    recordPhaseTimingsOnSpan(span, input.timings);
  }

  if (input.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: input.error.message });
    span.recordException(input.error);
    span.setAttribute('error.type', input.error.name || 'Error');
  } else if (input.outcome === 'delivered') {
    span.setStatus({ code: SpanStatusCode.OK });
  } else {
    // A 429 or 5xx is a completed round-trip that failed the delivery, not a
    // transport error; still an ERROR for the span so Jaeger filters find it.
    span.setStatus({ code: SpanStatusCode.ERROR, message: input.outcome });
  }
}

export interface WebhookDispatchMetricsOptions {
  timings: HttpPhaseDurations | null | undefined;
  outcome: string;
  status?: number | null;
}

/**
 * Process-local Prometheus registry for webhook dispatch.
 *
 * Deliberately hand-rolled in the same style as the existing `/metrics`
 * endpoint rather than pulling in a metrics client, and exported from the same
 * process that dispatches so the numbers include worker-only activity.
 */
export class WebhookDispatchMetrics {
  private readonly phaseDuration = new Histogram(
    `${PREFIX}_phase_duration_seconds`,
    'Wall-clock duration of each HTTP phase of a webhook delivery attempt',
    'phase',
  );

  private readonly totalDuration = new Histogram(
    `${PREFIX}_duration_seconds`,
    'End-to-end wall-clock duration of a webhook delivery attempt',
    'result',
  );

  private readonly attempts = new LabelCounter(
    `${PREFIX}_attempts_total`,
    'Webhook delivery attempts by terminal outcome',
    'outcome',
  );

  private readonly inFlight = new Gauge(
    `${PREFIX}_in_flight`,
    'Webhook delivery attempts currently in flight in this process',
  );

  beginAttempt(): void {
    this.inFlight.inc();
  }

  endAttempt(): void {
    this.inFlight.dec();
  }

  /**
   * Records one attempt. Unknown outcomes are coerced to `connection_error`
   * rather than dropped, so a new call site degrades into a (slightly wrong)
   * series instead of silently losing the observation.
   */
  record({ timings, outcome, status }: WebhookDispatchMetricsOptions): void {
    const normalized = isWebhookDispatchOutcome(outcome) ? outcome : 'connection_error';
    this.attempts.inc(normalized);
    this.totalDuration.observe(classifyWebhookStatus(status), timings?.totalMs ?? 0);

    if (!timings) return;
    const phases: Array<[HttpPhaseName, number | null]> = [
      [HTTP_PHASE_DNS, timings.dnsMs],
      [HTTP_PHASE_TCP_CONNECT, timings.tcpConnectMs],
      [HTTP_PHASE_TLS_HANDSHAKE, timings.tlsHandshakeMs],
      [HTTP_PHASE_TTFB, timings.ttfbMs],
      [HTTP_PHASE_RESPONSE_STREAM, timings.responseStreamMs],
    ];
    for (const [phase, value] of phases) {
      if (value === null) continue;
      this.phaseDuration.observe(phase, value);
    }
  }

  attemptsByOutcome(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const outcome of OUTCOMES) {
      snapshot[outcome] = this.attempts.get(outcome);
    }
    return snapshot;
  }

  render(): string {
    return [
      this.phaseDuration.render(),
      '',
      this.totalDuration.render(),
      '',
      this.attempts.render(),
      '',
      this.inFlight.render(),
      '',
    ].join('\n');
  }

  reset(): void {
    this.phaseDuration.reset();
    this.totalDuration.reset();
    this.attempts.reset();
    this.inFlight.reset();
  }
}

export const webhookDispatchMetrics = new WebhookDispatchMetrics();

/** Creates the client span that a single webhook HTTP attempt hangs off. */
export function startWebhookDispatchSpan(
  name: string = WEBHOOK_DISPATCH_SPAN_NAME,
): Span {
  return webhookTracer.startSpan(name, { kind: SpanKind.CLIENT });
}
