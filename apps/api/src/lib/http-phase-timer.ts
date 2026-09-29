/**
 * Per-phase wall-clock timing for outbound webhook delivery requests.
 *
 * The dispatcher needs to know *where* time goes on a webhook POST — name
 * resolution, TCP connect, TLS handshake, time-to-first-byte, and draining the
 * response body — because each has a completely different remediation (DNS
 * resolver pressure, SYN backlog, certificate/CPU problems, slow handler, slow
 * or non-draining endpoint). A single end-to-end number cannot tell them apart.
 *
 * `HttpPhaseTimer` records absolute completion timestamps for each phase and
 * derives per-phase durations from the gaps between them, so any phase may be
 * absent without distorting the others:
 *
 * - A keep-alive socket is reused, so `dns`, `tcp_connect` and `tls_handshake`
 *   are never marked and report `null` (the work genuinely did not happen).
 * - A plain-HTTP endpoint never marks `tls_handshake`.
 * - A failure before the response headers arrive leaves `ttfb` and
 *   `response_stream` unset.
 *
 * `null` is therefore always "not observed", never "zero". Callers that need a
 * numeric total (histograms, SLO math) should use `totalMs`, which is always
 * present, rather than summing the individual phases.
 *
 * The clock is injectable so tests can assert exact durations without sleeping.
 */

export const HTTP_PHASE_DNS = 'dns';
export const HTTP_PHASE_TCP_CONNECT = 'tcp_connect';
export const HTTP_PHASE_TLS_HANDSHAKE = 'tls_handshake';
export const HTTP_PHASE_TTFB = 'ttfb';
export const HTTP_PHASE_RESPONSE_STREAM = 'response_stream';

export type HttpPhaseName =
  | typeof HTTP_PHASE_DNS
  | typeof HTTP_PHASE_TCP_CONNECT
  | typeof HTTP_PHASE_TLS_HANDSHAKE
  | typeof HTTP_PHASE_TTFB
  | typeof HTTP_PHASE_RESPONSE_STREAM;

/** Ordered exactly as a fresh connection progresses; used for exposition and docs. */
export const HTTP_PHASE_NAMES: readonly HttpPhaseName[] = [
  HTTP_PHASE_DNS,
  HTTP_PHASE_TCP_CONNECT,
  HTTP_PHASE_TLS_HANDSHAKE,
  HTTP_PHASE_TTFB,
  HTTP_PHASE_RESPONSE_STREAM,
] as const;

/**
 * Durations in milliseconds. A `null` entry means the phase was never observed
 * on this request (see the module comment) — it is deliberately distinct from
 * `0`, which means "observed and instantaneous".
 */
export interface HttpPhaseDurations {
  dnsMs: number | null;
  tcpConnectMs: number | null;
  tlsHandshakeMs: number | null;
  ttfbMs: number | null;
  responseStreamMs: number | null;
  /** Wall-clock time from starting the request until the body was fully drained. */
  totalMs: number;
}

function defaultClock(): number {
  // performance.now() is monotonic, so a system clock adjustment mid-request
  // cannot produce a negative or wildly wrong phase duration.
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function elapsed(until: number | undefined, since: number | undefined, start: number): number | null {
  if (until === undefined) return null;
  return Math.max(0, until - (since ?? start));
}

export class HttpPhaseTimer {
  private readonly now: () => number;
  private readonly startTime: number;
  private readonly marks = new Map<HttpPhaseName, number>();
  private endTime: number | null = null;

  constructor(now: () => number = defaultClock) {
    this.now = now;
    this.startTime = now();
  }

  /**
   * Records that a phase finished. The first mark for a phase wins so a
   * late-arriving duplicate (e.g. a socket emitting `connect` after the
   * response already landed on a reused connection) cannot shrink a duration.
   */
  mark(phase: HttpPhaseName): this {
    if (!this.marks.has(phase)) {
      this.marks.set(phase, this.now());
    }
    return this;
  }

  /** Freezes the total. Safe to call repeatedly; only the first call takes effect. */
  finish(): this {
    if (this.endTime === null) {
      this.endTime = this.now();
    }
    return this;
  }

  has(phase: HttpPhaseName): boolean {
    return this.marks.has(phase);
  }

  /** Milliseconds elapsed so far, whether or not `finish()` has been called. */
  totalMs(): number {
    return Math.max(0, (this.endTime ?? this.now()) - this.startTime);
  }

  durations(): HttpPhaseDurations {
    const dns = this.marks.get(HTTP_PHASE_DNS);
    const tcp = this.marks.get(HTTP_PHASE_TCP_CONNECT);
    const tls = this.marks.get(HTTP_PHASE_TLS_HANDSHAKE);
    const ttfb = this.marks.get(HTTP_PHASE_TTFB);
    const stream = this.marks.get(HTTP_PHASE_RESPONSE_STREAM);

    return {
      dnsMs: elapsed(dns, undefined, this.startTime),
      tcpConnectMs: elapsed(tcp, dns, this.startTime),
      tlsHandshakeMs: elapsed(tls, tcp ?? dns, this.startTime),
      ttfbMs: elapsed(ttfb, tls ?? tcp ?? dns, this.startTime),
      responseStreamMs: elapsed(stream, ttfb ?? tls ?? tcp ?? dns, this.startTime),
      totalMs: this.totalMs(),
    };
  }
}
