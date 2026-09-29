import { describe, it, expect } from 'vitest';
import {
  HttpPhaseTimer,
  HTTP_PHASE_DNS,
  HTTP_PHASE_TCP_CONNECT,
  HTTP_PHASE_TLS_HANDSHAKE,
  HTTP_PHASE_TTFB,
  HTTP_PHASE_RESPONSE_STREAM,
  HTTP_PHASE_NAMES,
} from '../http-phase-timer';

/** Deterministic monotonic clock so assertions never depend on real timing. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('HttpPhaseTimer', () => {
  it('derives per-phase durations from the gaps between marks', () => {
    const clock = fakeClock();
    const timer = new HttpPhaseTimer(clock.now);

    clock.advance(10);
    timer.mark(HTTP_PHASE_DNS);
    clock.advance(20);
    timer.mark(HTTP_PHASE_TCP_CONNECT);
    clock.advance(30);
    timer.mark(HTTP_PHASE_TLS_HANDSHAKE);
    clock.advance(40);
    timer.mark(HTTP_PHASE_TTFB);
    clock.advance(50);
    timer.mark(HTTP_PHASE_RESPONSE_STREAM);
    timer.finish();

    expect(timer.durations()).toEqual({
      dnsMs: 10,
      tcpConnectMs: 20,
      tlsHandshakeMs: 30,
      ttfbMs: 40,
      responseStreamMs: 50,
      totalMs: 150,
    });
  });

  it('reports an unobserved phase as null, never as zero', () => {
    const clock = fakeClock();
    const timer = new HttpPhaseTimer(clock.now);

    clock.advance(5);
    timer.mark(HTTP_PHASE_TTFB);
    clock.advance(5);
    timer.mark(HTTP_PHASE_RESPONSE_STREAM);
    timer.finish();

    const d = timer.durations();
    expect(d.dnsMs).toBeNull();
    expect(d.tcpConnectMs).toBeNull();
    expect(d.tlsHandshakeMs).toBeNull();
    // A null is meaningfully different from an observed instantaneous phase.
    expect(d.ttfbMs).toBe(5);
    expect(d.ttfbMs).not.toBe(0);
  });

  it('leaves ttfb and response_stream null when the request fails before headers', () => {
    const clock = fakeClock();
    const timer = new HttpPhaseTimer(clock.now);

    clock.advance(3);
    timer.mark(HTTP_PHASE_DNS);
    clock.advance(7);
    timer.mark(HTTP_PHASE_TCP_CONNECT);
    timer.finish();

    const d = timer.durations();
    expect(d.dnsMs).toBe(3);
    expect(d.tcpConnectMs).toBe(7);
    expect(d.ttfbMs).toBeNull();
    expect(d.responseStreamMs).toBeNull();
    expect(d.totalMs).toBe(10);
  });

  it('does not mark tls_handshake for a plain-HTTP endpoint', () => {
    const clock = fakeClock();
    const timer = new HttpPhaseTimer(clock.now);

    clock.advance(1);
    timer.mark(HTTP_PHASE_DNS);
    clock.advance(2);
    timer.mark(HTTP_PHASE_TCP_CONNECT);
    clock.advance(4);
    timer.mark(HTTP_PHASE_TTFB);
    timer.mark(HTTP_PHASE_RESPONSE_STREAM);
    timer.finish();

    const d = timer.durations();
    expect(timer.has(HTTP_PHASE_TLS_HANDSHAKE)).toBe(false);
    expect(d.tlsHandshakeMs).toBeNull();
    // TTFB is measured from the TCP connect, not from a TLS mark that never happened.
    expect(d.ttfbMs).toBe(4);
  });

  it('keeps the first mark so a late duplicate cannot shrink a duration', () => {
    const clock = fakeClock();
    const timer = new HttpPhaseTimer(clock.now);

    clock.advance(10);
    timer.mark(HTTP_PHASE_DNS);
    clock.advance(90);
    timer.mark(HTTP_PHASE_DNS);

    expect(timer.durations().dnsMs).toBe(10);
  });

  it('exposes totalMs while running and freezes it on finish', () => {
    const clock = fakeClock();
    const timer = new HttpPhaseTimer(clock.now);

    clock.advance(7);
    expect(timer.totalMs()).toBe(7);

    timer.finish();
    clock.advance(1000);
    expect(timer.totalMs()).toBe(7);

    // finish() is idempotent.
    timer.finish();
    expect(timer.totalMs()).toBe(7);
  });

  it('never reports a negative duration if the clock steps backwards', () => {
    let t = 100;
    const timer = new HttpPhaseTimer(() => t);
    t = 40;
    timer.mark(HTTP_PHASE_DNS);
    timer.finish();

    expect(timer.durations().dnsMs).toBe(0);
  });

  it('lists phases in connection order for exposition and docs', () => {
    expect(HTTP_PHASE_NAMES).toEqual([
      'dns',
      'tcp_connect',
      'tls_handshake',
      'ttfb',
      'response_stream',
    ]);
  });
});
