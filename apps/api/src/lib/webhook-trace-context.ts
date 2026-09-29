/**
 * W3C Trace Context propagation for the webhook dispatcher.
 *
 * A payment alert is produced in the watcher worker, queued in BullMQ, and
 * delivered by the dispatcher — potentially in a different process and minutes
 * later. Without propagation, the delivery shows up in Jaeger as an orphan
 * trace with no link to the ingestion that caused it. The queue boundary is
 * where the trace has to be carried by hand, because BullMQ serialises plain
 * JSON and cannot carry an `opentelemetry-api` `Context`.
 *
 * This module implements the W3C Trace Context wire format directly
 * (https://www.w3.org/TR/trace-context/) rather than going through the global
 * OpenTelemetry propagator, for three reasons:
 *
 *  1. `tracestate` has no representation on a `SpanContext`, so a
 *     propagator round-trip silently drops it. The dispatcher needs to hand the
 *     *caller's* `tracestate` to the customer's endpoint untouched.
 *  2. The no-op default propagator (what tests and any process that has not
 *     called `startTelemetry()` get) injects nothing, so header injection would
 *     be untestable and would vanish in exactly the deployments that have not
 *     rolled telemetry out yet.
 *  3. It keeps the queue payload format under our control: we can parse and
 *     validate on the producer side and reject junk at enqueue time.
 *
 * The global propagator is still installed by `startTelemetry()` for the rest of
 * the OpenTelemetry instrumentation; this module is additive to it.
 */
import {
  context,
  createContextKey,
  trace,
  TraceFlags,
  type Context,
  type SpanContext,
} from '@opentelemetry/api';

export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

/** Fields added to `AlertJobData` to carry the trace across the BullMQ boundary. */
export const TRACEPARENT_JOB_FIELD = 'traceparent';
export const TRACESTATE_JOB_FIELD = 'tracestate';

const SUPPORTED_VERSION = '00';
const TRACEPARENT_PATTERN =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

/** Context key used to carry an unparsed `tracestate` string alongside the SpanContext. */
const TRACESTATE_CONTEXT_KEY = createContextKey(
  'stellar-alerts.tracestate',
);

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  spanId: string;
  traceFlags: string;
}

export interface TraceContextCarrier {
  traceparent?: string;
  tracestate?: string;
}

/** A carrier that can be embedded verbatim in a BullMQ job payload. */
export type QueueTraceContext = TraceContextCarrier;

function isValidHex(value: string, length: number): boolean {
  if (value.length !== length) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isLowerHex = code >= 97 && code <= 102;
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

/**
 * Parses a `traceparent` header.
 *
 * Returns `null` for anything the W3C spec says must be treated as absent:
 * malformed headers, a non-zero-length all-zero trace id, an all-zero span id,
 * and any version above the one we understand that carries an unexpected
 * field count. Per spec an unparsable header must never be forwarded onward.
 */
export function parseTraceparent(value: unknown): ParsedTraceparent | null {
  if (typeof value !== 'string' || value.length === 0) return null;

  const match = TRACEPARENT_PATTERN.exec(value.trim());
  if (!match) return null;

  const [, version, traceId, spanId, traceFlags] = match;

  // Version ff is forbidden by the spec. Higher versions are forward-compatible,
  // but only when they do not add trailing fields we would silently drop.
  if (version === 'ff') return null;
  if (version !== SUPPORTED_VERSION && value.trim().split('-').length > 4) return null;

  if (!isValidHex(traceId, 32) || traceId === INVALID_TRACE_ID) return null;
  if (!isValidHex(spanId, 16) || spanId === INVALID_SPAN_ID) return null;

  return { version, traceId, spanId, traceFlags };
}

/** Serialises a `SpanContext` back into a `traceparent` header value. */
export function formatTraceparent(spanContext: SpanContext | undefined | null): string | null {
  if (!spanContext || !isValidHex(spanContext.traceId, 32) || spanContext.traceId === INVALID_TRACE_ID) {
    return null;
  }
  if (!isValidHex(spanContext.spanId, 16) || spanContext.spanId === INVALID_SPAN_ID) {
    return null;
  }
  const flags = (spanContext.traceFlags & TraceFlags.SAMPLED ? TraceFlags.SAMPLED : TraceFlags.NONE)
    .toString(16)
    .padStart(2, '0');
  return `${SUPPORTED_VERSION}-${spanContext.traceId.toLowerCase()}-${spanContext.spanId.toLowerCase()}-${flags}`;
}

function tracestateFromContext(ctx: Context): string | undefined {
  return ctx.getValue(TRACESTATE_CONTEXT_KEY) as string | undefined;
}

function normalizeTracestate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // W3C caps a tracestate header at 512 characters across at most 32 members.
  return trimmed.length > 512 ? undefined : trimmed;
}

/**
 * Wraps a remote carrier in a `Context` whose active span is the remote span,
 * so spans started underneath become children of the producer's span.
 *
 * Falls back to the currently active context when the carrier is absent or
 * invalid, which is the normal case for jobs enqueued before this feature
 * shipped — those simply start a fresh trace rather than failing.
 */
export function extractTraceContext(carrier: TraceContextCarrier | null | undefined): Context {
  const active = context.active();
  if (!carrier) return active;

  const parsed = parseTraceparent(carrier.traceparent);
  if (!parsed) return active;

  const spanContext: SpanContext = {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: (parseInt(parsed.traceFlags, 16) & TraceFlags.SAMPLED) !== 0
      ? TraceFlags.SAMPLED
      : TraceFlags.NONE,
    isRemote: true,
  };

  let ctx = trace.setSpanContext(active, spanContext);
  const tracestate = normalizeTracestate(carrier.tracestate);
  if (tracestate) {
    ctx = ctx.setValue(TRACESTATE_CONTEXT_KEY, tracestate);
  }
  return ctx;
}

/**
 * Injects the active trace context into outbound HTTP headers.
 *
 * Returns the same object for chaining convenience. Headers are only added when
 * there is a valid active span, so a process without a tracer provider (or a
 * job with no producer context) sends no traceparent at all rather than a
 * syntactically valid header full of zeros that downstream systems would trust.
 */
export function injectTraceContext(
  headers: Record<string, string>,
  ctx: Context = context.active(),
): Record<string, string> {
  const spanContext = trace.getSpanContext(ctx);
  const traceparent = formatTraceparent(spanContext);
  if (traceparent) {
    headers[TRACEPARENT_HEADER] = traceparent;
  }
  const tracestate = tracestateFromContext(ctx);
  if (tracestate) {
    headers[TRACESTATE_HEADER] = tracestate;
  }
  return headers;
}

/**
 * Snapshots the active trace context into a plain object suitable for a BullMQ
 * job payload. Returns an empty carrier when there is no valid active span, so
 * `enqueuePaymentAlert` can always spread the result into job data.
 */
export function captureQueueTraceContext(ctx: Context = context.active()): QueueTraceContext {
  const traceparent = formatTraceparent(trace.getSpanContext(ctx));
  if (!traceparent) return {};
  const carrier: QueueTraceContext = { traceparent };
  const tracestate = tracestateFromContext(ctx);
  if (tracestate) carrier.tracestate = tracestate;
  return carrier;
}

/** Reads the trace context out of an arbitrary job payload, tolerating junk. */
export function queueTraceContextFromJob(job: unknown): QueueTraceContext | null {
  if (!job || typeof job !== 'object') return null;
  const data = job as Record<string, unknown>;
  const traceparent = data[TRACEPARENT_JOB_FIELD];
  if (typeof traceparent !== 'string' || !parseTraceparent(traceparent)) return null;
  const carrier: QueueTraceContext = { traceparent: traceparent.trim() };
  const tracestate = normalizeTracestate(data[TRACESTATE_JOB_FIELD]);
  if (tracestate) carrier.tracestate = tracestate;
  return carrier;
}

/**
 * Runs `fn` with the carrier's trace context active. Returns whatever `fn`
 * returns, awaited, so it composes with the async dispatch path.
 */
export async function runWithQueueTraceContext<T>(
  carrier: TraceContextCarrier | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = extractTraceContext(carrier);
  return context.with(ctx, fn);
}
