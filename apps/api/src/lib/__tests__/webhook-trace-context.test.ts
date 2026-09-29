import { describe, it, expect } from 'vitest';
import {
  context,
  trace,
  TraceFlags,
  ROOT_CONTEXT,
  type SpanContext,
} from '@opentelemetry/api';
import {
  parseTraceparent,
  formatTraceparent,
  extractTraceContext,
  injectTraceContext,
  captureQueueTraceContext,
  queueTraceContextFromJob,
  runWithQueueTraceContext,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from '../webhook-trace-context';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const VALID_TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

function spanContext(overrides: Partial<SpanContext> = {}): SpanContext {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    ...overrides,
  };
}

describe('parseTraceparent', () => {
  it('parses a well-formed header', () => {
    expect(parseTraceparent(VALID_TRACEPARENT)).toEqual({
      version: '00',
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: '01',
    });
  });

  it('rejects an all-zero trace id', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects an all-zero span id', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull();
  });

  it('rejects the forbidden version ff', () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects a future version carrying trailing fields we would drop', () => {
    expect(parseTraceparent(`cc-${TRACE_ID}-${SPAN_ID}-01-extra`)).toBeNull();
  });

  it('accepts a future version with the standard field count', () => {
    expect(parseTraceparent(`cc-${TRACE_ID}-${SPAN_ID}-01`)?.version).toBe('cc');
  });

  it.each([
    ['uppercase hex', `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`],
    ['short trace id', '00-4bf92f3577b34da6a3ce929d0e0e473-SPAN-01'],
    ['short span id', `00-${TRACE_ID}-00f067aa-01`],
    ['missing flags', `00-${TRACE_ID}-${SPAN_ID}`],
    ['non-hex characters', `00-${TRACE_ID}-zzzzzzzzzzzzzzzz-01`],
    ['a trailing separator', `${VALID_TRACEPARENT}-`],
  ])('rejects %s', (_label, value) => {
    expect(parseTraceparent(value)).toBeNull();
  });

  it('tolerates surrounding whitespace, which HTTP strips as optional whitespace', () => {
    expect(parseTraceparent(`  ${VALID_TRACEPARENT} `)?.traceId).toBe(TRACE_ID);
  });

  it.each([null, undefined, 42, {}, [], ''])(
    'rejects non-string input %#',
    (value) => {
      expect(parseTraceparent(value)).toBeNull();
    },
  );
});

describe('formatTraceparent', () => {
  it('round-trips a sampled span context', () => {
    expect(formatTraceparent(spanContext())).toBe(VALID_TRACEPARENT);
  });

  it('renders the unsampled flag', () => {
    expect(formatTraceparent(spanContext({ traceFlags: TraceFlags.NONE }))).toBe(
      `00-${TRACE_ID}-${SPAN_ID}-00`,
    );
  });

  it('returns null for an all-zero id so downstream never sees a fake valid header', () => {
    expect(formatTraceparent(spanContext({ traceId: '0'.repeat(32) }))).toBeNull();
    expect(formatTraceparent(spanContext({ spanId: '0'.repeat(16) }))).toBeNull();
    expect(formatTraceparent(undefined)).toBeNull();
  });
});

describe('extractTraceContext', () => {
  it('makes the remote span the active parent', () => {
    const ctx = extractTraceContext({ traceparent: VALID_TRACEPARENT });
    expect(trace.getSpanContext(ctx)).toMatchObject({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  });

  it('clears the sampled flag for an unsampled producer', () => {
    const ctx = extractTraceContext({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-00`,
    });
    expect(trace.getSpanContext(ctx)?.traceFlags).toBe(TraceFlags.NONE);
  });

  it.each([null, undefined, {}, { traceparent: 'garbage' }])(
    'falls back to the active context for an absent or invalid carrier %#',
    (carrier) => {
      expect(extractTraceContext(carrier)).toBe(context.active());
    },
  );
});

describe('injectTraceContext', () => {
  it('injects a traceparent derived from the active span', () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, spanContext());
    const headers = injectTraceContext({}, ctx);

    expect(headers[TRACEPARENT_HEADER]).toBe(VALID_TRACEPARENT);
    expect(headers[TRACESTATE_HEADER]).toBeUndefined();
  });

  it('injects no header at all when there is no valid active span', () => {
    // This is the no-op-tracer case (tests, or a process that never started
    // telemetry): sending a zero-filled traceparent would be worse than nothing.
    const headers = injectTraceContext({}, ROOT_CONTEXT);
    expect(headers[TRACEPARENT_HEADER]).toBeUndefined();
  });

  it('forwards the caller tracestate untouched', () => {
    const ctx = extractTraceContext({
      traceparent: VALID_TRACEPARENT,
      tracestate: 'vendor1=abc,vendor2=def',
    });
    const headers = injectTraceContext({}, ctx);

    expect(headers[TRACESTATE_HEADER]).toBe('vendor1=abc,vendor2=def');
  });
});

describe('queue trace context', () => {
  it('captures a valid carrier from the active span', () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, spanContext());
    expect(captureQueueTraceContext(ctx)).toEqual({
      traceparent: VALID_TRACEPARENT,
    });
  });

  it('captures an empty carrier when there is no active span', () => {
    expect(captureQueueTraceContext(ROOT_CONTEXT)).toEqual({});
  });

  it('reads a carrier back out of a job payload', () => {
    expect(
      queueTraceContextFromJob({
        traceparent: VALID_TRACEPARENT,
        tracestate: 'vendor1=abc',
      }),
    ).toEqual({ traceparent: VALID_TRACEPARENT, tracestate: 'vendor1=abc' });
  });

  it.each([null, undefined, 'string', 42, {}, { traceparent: 123 }, { traceparent: 'bad' }])(
    'returns null for a job without a usable traceparent %#',
    (job) => {
      expect(queueTraceContextFromJob(job)).toBeNull();
    },
  );

  it('discards an over-length tracestate', () => {
    const carrier = queueTraceContextFromJob({
      traceparent: VALID_TRACEPARENT,
      tracestate: 'a'.repeat(600),
    });
    expect(carrier).toEqual({ traceparent: VALID_TRACEPARENT });
  });

  it('survives a full capture -> job payload -> extract round trip', () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, spanContext());
    const captured = captureQueueTraceContext(ctx);

    // A BullMQ payload is plain JSON; only these fields cross the boundary.
    const jobPayload = JSON.parse(JSON.stringify(captured));
    const restored = extractTraceContext(queueTraceContextFromJob(jobPayload));

    expect(trace.getSpanContext(restored)).toMatchObject({
      traceId: TRACE_ID,
      isRemote: true,
    });
  });
});

describe('runWithQueueTraceContext', () => {
  // NOTE: asserting that `context.with` actually makes the remote span ambient
  // requires a globally registered context manager, which only exists once
  // `startTelemetry()` has run (the NodeSDK registers AsyncLocalStorage
  // context-manager). These unit tests do not start the SDK, so the
  // parent-linking semantics are covered above through the explicit-context
  // `extractTraceContext`/`injectTraceContext` path instead; what is verified
  // here is the part that does not depend on a context manager.
  it('returns the callback result', async () => {
    const result = await runWithQueueTraceContext(
      { traceparent: VALID_TRACEPARENT },
      async () => 'delivered',
    );

    expect(result).toBe('delivered');
  });

  it('propagates a dispatch failure to the caller', async () => {
    await expect(
      runWithQueueTraceContext({ traceparent: VALID_TRACEPARENT }, async () => {
        throw new Error('dispatch failed');
      }),
    ).rejects.toThrow('dispatch failed');
  });

  it('still runs the callback for a job with no producer context', async () => {
    const result = await runWithQueueTraceContext(null, async () => 'delivered');
    expect(result).toBe('delivered');
  });
});
