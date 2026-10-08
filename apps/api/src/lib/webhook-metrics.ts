/**
 * Prometheus instrumentation for outbound webhook dispatch.
 *
 * The API already exposes hand-rolled Prometheus text on `/metrics` (see
 * `plugins/metrics.ts`); this module follows the same dependency-free approach
 * and adds the histograms needed to observe *where* a webhook delivery spends
 * its time: DNS lookup, TCP connect, TLS handshake, time-to-first-byte and
 * response body streaming.
 *
 * Phase timings are recorded as a single histogram carrying a `phase` label so
 * that `histogram_quantile` over a filtered series works as expected in
 * dashboards and alert rules.
 */

/** Ordered lifecycle phases of a single outbound webhook request. */
export const WEBHOOK_DISPATCH_PHASES = [
  'dns_lookup',
  'tcp_connect',
  'tls_handshake',
  'ttfb',
  'response_stream',
] as const;

export type WebhookDispatchPhase = (typeof WEBHOOK_DISPATCH_PHASES)[number];

/**
 * Upper bounds in milliseconds. Chosen to straddle the observed range for
 * subscriber endpoints: local/edge targets land in the single-digit buckets
 * while slow third-party endpoints tail out into the multi-second buckets.
 */
export const WEBHOOK_DISPATCH_BUCKETS_MS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

/** Terminal outcome of a dispatch attempt. */
export type WebhookDispatchOutcome = 'delivered' | 'failed';

interface HistogramSeries {
  /** Per-bucket observation counts, index-aligned with the bucket bounds. */
  counts: number[];
  sum: number;
  count: number;
}

class Histogram {
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly bounds: readonly number[],
  ) {}

  private readonly series = new Map<string, HistogramSeries>();

  observe(labels: string, valueMs: number): void {
    // Guard against NaN/Infinity poisoning the exposition output: a single bad
    // sample would otherwise produce invalid Prometheus text and fail the
    // whole scrape.
    if (!Number.isFinite(valueMs)) return;

    let entry = this.series.get(labels);
    if (!entry) {
      entry = { counts: new Array(this.bounds.length).fill(0), sum: 0, count: 0 };
      this.series.set(labels, entry);
    }

    entry.sum += valueMs;
    entry.count += 1;
    for (let i = 0; i < this.bounds.length; i++) {
      if (valueMs <= this.bounds[i]) {
        entry.counts[i] += 1;
      }
    }
  }

  reset(): void {
    this.series.clear();
  }

  render(): string[] {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];

    if (this.series.size === 0) {
      return lines;
    }

    for (const [labels, entry] of this.series) {
      // A histogram bucket carries `le` inside the same label set as the series
      // labels, e.g. `_bucket{phase="ttfb",le="+Inf"}`. Emitting a second brace
      // group would produce text Prometheus cannot parse.
      const withBound = (bound: string) => (labels ? `${labels},le="${bound}"` : `le="${bound}"`);

      // Prometheus requires cumulative bucket counts in ascending `le` order,
      // terminated by the required `+Inf` bucket.
      for (let i = 0; i < this.bounds.length; i++) {
        lines.push(`${this.name}_bucket{${withBound(String(this.bounds[i]))}} ${entry.counts[i]}`);
      }
      lines.push(`${this.name}_bucket{${withBound('+Inf')}} ${entry.count}`);

      const sumSuffix = labels ? `_sum{${labels}}` : '_sum';
      const countSuffix = labels ? `_count{${labels}}` : '_count';
      lines.push(`${this.name}${sumSuffix} ${entry.sum}`);
      lines.push(`${this.name}${countSuffix} ${entry.count}`);
    }

    return lines;
  }
}

class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  increment(labels: string): void {
    this.values.set(labels, (this.values.get(labels) ?? 0) + 1);
  }

  reset(): void {
    this.values.clear();
  }

  render(): string[] {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [labels, value] of this.values) {
      lines.push(`${this.name}{${labels}} ${value}`);
    }
    return lines;
  }
}

const phaseHistogram = new Histogram(
  'stellar_alerts_webhook_dispatch_phase_duration_seconds',
  'Wall-clock duration of each phase of an outbound webhook dispatch',
  WEBHOOK_DISPATCH_BUCKETS_MS,
);

const totalHistogram = new Histogram(
  'stellar_alerts_webhook_dispatch_total_duration_seconds',
  'End-to-end wall-clock duration of an outbound webhook dispatch',
  WEBHOOK_DISPATCH_BUCKETS_MS,
);

const dispatchCounter = new Counter(
  'stellar_alerts_webhook_dispatch_total',
  'Total outbound webhook dispatch attempts by outcome',
);

/**
 * Records a phase duration. Phases that did not occur (for example TLS on a
 * plaintext endpoint, or DNS/TCP/TLS on a reused keep-alive socket) must be
 * skipped by the caller rather than recorded as zero, so that the `phase` label
 * stays a truthful description of work actually performed.
 */
export function recordWebhookDispatchPhase(phase: WebhookDispatchPhase, durationMs: number): void {
  phaseHistogram.observe(`phase="${phase}"`, durationMs);
}

export function recordWebhookDispatchTotal(durationMs: number, outcome: WebhookDispatchOutcome): void {
  totalHistogram.observe(`outcome="${outcome}"`, durationMs);
  dispatchCounter.increment(`outcome="${outcome}"`);
}

/** Renders the webhook dispatch metrics in Prometheus text exposition format. */
export function renderWebhookDispatchMetrics(): string {
  return [...phaseHistogram.render(), ...totalHistogram.render(), ...dispatchCounter.render()].join('\n');
}

/** Clears all webhook dispatch metrics. Exposed for test isolation. */
export function resetWebhookDispatchMetrics(): void {
  phaseHistogram.reset();
  totalHistogram.reset();
  dispatchCounter.reset();
}
