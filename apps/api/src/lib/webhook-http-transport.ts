/**
 * Instrumented HTTP transport for webhook delivery.
 *
 * The rest of the codebase talks to providers through `fetch` (see
 * `external-request.ts`), and that stays the default. `fetch` runs on undici,
 * which exposes no per-connection callbacks, so a `fetch`-based dispatcher can
 * report end-to-end latency and nothing else — there is no way to tell a DNS
 * resolver stall from a TLS handshake problem from a slow customer handler.
 *
 * This module drives `node:http`/`node:https` directly for the webhook POST so
 * the real connection milestones are observable:
 *
 * - DNS      via a custom `lookup`, timed from call to callback
 * - TCP      via the socket's `connect` event
 * - TLS      via the socket's `secureConnect` event
 * - TTFB     via the `response` event (response headers received)
 * - Stream   from `response` to the end of the body
 *
 * On a keep-alive connection the first three never happen, so they are reported
 * as `null` and `reusedConnection` is set — reporting a reused socket as three
 * instantaneous phases would be a lie that hides exactly the numbers operators
 * are looking for.
 *
 * Behaviour is kept equivalent to `fetch(url, { redirect: 'follow' })`:
 * 301/302/303 downgrade to GET, 307/308 preserve method and body, and the hop
 * cap is enforced. Redirect targets are handed to an `onRedirect` hook so the
 * caller can re-run its SSRF policy against every hop, not just the first URL.
 *
 * `sendInstrumentedWebhookRequest` sits on top of the two transports and owns
 * the per-attempt instrumentation: W3C trace header injection, the client span,
 * the Prometheus samples, and the rollback switch.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import {
  HTTP_PHASE_DNS,
  HTTP_PHASE_TCP_CONNECT,
  HTTP_PHASE_TLS_HANDSHAKE,
  HTTP_PHASE_RESPONSE_STREAM,
  HTTP_PHASE_TTFB,
  HttpPhaseTimer,
  type HttpPhaseDurations,
} from './http-phase-timer';
import {
  ExternalRequestTimeoutError,
  createDeadlineSignal,
  fetchWithTimeout,
} from './external-request';
import { env, envFlag } from '../config/env';
import { injectTraceContext } from './webhook-trace-context';
import {
  finalizeWebhookDispatchSpan,
  startWebhookDispatchSpan,
  webhookDispatchMetrics,
  type WebhookDispatchOutcome,
} from './webhook-telemetry';

export const DEFAULT_MAX_REDIRECTS = 5;

/** Statuses the `Response` constructor refuses to attach a body to. */
const STATUS_WITHOUT_BODY = new Set([204, 205, 304]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Request headers that must be dropped when a redirect downgrades to GET. */
const BODY_HEADERS = new Set(['content-length', 'content-type', 'content-encoding', 'transfer-encoding']);

export interface WebhookHttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRedirects?: number;
  /**
   * Invoked before each redirect is followed. Throwing here aborts the
   * redirect chain, which is how the caller enforces SSRF policy per hop.
   */
  onRedirect?: (from: string, to: string) => void | Promise<void>;
}

export interface WebhookHttpRequestResult {
  response: Response;
  timings: HttpPhaseDurations;
  /** The URL that actually produced the response, after any redirects. */
  finalUrl: string;
  /** Redirect hops followed, in order. Empty when the first URL answered. */
  redirects: string[];
  /** True when the response came off a keep-alive socket (no DNS/TCP/TLS work). */
  reusedConnection: boolean;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * Times name resolution by marking the phase when the resolver calls back.
 * Handles both the `(host, options, cb)` and legacy `(host, cb)` call shapes.
 */
function createTimedLookup(timer: HttpPhaseTimer): (
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupOptions,
  callback: LookupCallback,
) => void {
  return (function timedLookup(this: unknown, ...args: unknown[]): void {
    const callback = args[args.length - 1] as LookupCallback;
    const timedCallback: LookupCallback = (err, address, family) => {
      timer.mark(HTTP_PHASE_DNS);
      (callback as (...rest: unknown[]) => void)(err, address, family);
    };
    (dns.lookup as unknown as (...rest: unknown[]) => void)(...args.slice(0, -1), timedCallback);
  }) as never;
}

function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    try {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else {
        headers.set(name, value);
      }
    } catch {
      // A destination echoing a header Node accepts but `Headers` rejects must
      // not fail the delivery; drop just that header.
    }
  }
  return headers;
}

function buildResponse(
  status: number,
  statusText: string | undefined,
  headers: Headers,
  body: Buffer,
): Response {
  const payload = STATUS_WITHOUT_BODY.has(status) ? null : new Uint8Array(body);
  if (statusText) {
    try {
      return new Response(payload, { status, statusText, headers });
    } catch {
      // Fall through to the reason-phrase-free form below.
    }
  }
  return new Response(payload, { status, headers });
}

function resolveRedirect(from: string, location: string): string {
  return new URL(location, from).toString();
}

interface HopOutcome {
  status: number;
  statusText: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  timings: HttpPhaseDurations;
  reusedConnection: boolean;
}

/** Performs a single request/response exchange with full phase instrumentation. */
function performHop(
  target: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
  provider: string,
): Promise<HopOutcome> {
  return new Promise<HopOutcome>((resolve, reject) => {
    const timer = new HttpPhaseTimer();
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestHeaders: Record<string, string> = { ...headers };
    if (body !== undefined && requestHeaders['content-length'] === undefined) {
      requestHeaders['content-length'] = String(Buffer.byteLength(body));
    }

    let settled = false;
    let reusedConnection = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };

    let request: http.ClientRequest;
    try {
      request = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: requestHeaders,
        lookup: createTimedLookup(timer),
      });
    } catch (err) {
      timer.finish();
      finish(() => reject(err));
      return;
    }

    function onAbort() {
      request.destroy(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });

    request.on('socket', (socket) => {
      // `connecting === false` is direct evidence the agent handed us a socket
      // from its pool: no DNS, TCP or TLS work happens on this request, so
      // those phases stay unmarked (reported as `null`) and the connection is
      // flagged as reused. This is tracked explicitly rather than inferred from
      // a missing DNS mark, because Node skips name resolution entirely for an
      // IP-literal host — an IP-addressed webhook URL would otherwise be
      // mislabelled as a reused connection on every delivery.
      if (!socket.connecting) {
        reusedConnection = true;
        return;
      }
      socket.once('connect', () => timer.mark(HTTP_PHASE_TCP_CONNECT));
      socket.once('secureConnect', () => timer.mark(HTTP_PHASE_TLS_HANDSHAKE));
    });

    request.on('response', (res) => {
      timer.mark(HTTP_PHASE_TTFB);
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        timer.mark(HTTP_PHASE_RESPONSE_STREAM);
        timer.finish();
        finish(() =>
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage,
            headers: res.headers,
            body: Buffer.concat(chunks),
            timings: timer.durations(),
            reusedConnection,
          }),
        );
      });
      res.on('error', (err) => {
        timer.finish();
        finish(() => reject(err));
      });
      res.on('aborted', () => {
        timer.finish();
        finish(() => reject(new Error(`Webhook response stream aborted by ${provider}`)));
      });
    });

    request.on('error', (err) => {
      timer.finish();
      finish(() => reject(err));
    });

    if (body !== undefined) request.write(body);
    request.end();
  });
}

/**
 * Issues the request, following redirects the way `fetch` does.
 *
 * Throws `ExternalRequestTimeoutError` when the deadline elapses, matching
 * `fetchWithTimeout` so the dispatcher's existing error handling is unchanged.
 */
export async function requestWithPhaseTimings(
  options: WebhookHttpRequestOptions,
): Promise<WebhookHttpRequestResult> {
  const provider = 'Webhook';
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const { signal, cleanup, isTimedOut } = createDeadlineSignal(timeoutMs, options.signal);

  const redirects: string[] = [];
  let currentUrl = options.url;
  let method = (options.method ?? 'POST').toUpperCase();
  let body = options.body;
  let headers: Record<string, string> = { ...(options.headers ?? {}) };

  try {
    for (let hop = 0; ; hop += 1) {
      let target: URL;
      try {
        target = new URL(currentUrl);
      } catch {
        throw new Error(`Invalid webhook URL: ${currentUrl}`);
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error(`Unsupported webhook protocol: ${target.protocol}`);
      }

      const outcome = await performHop(target, method, headers, body, signal, provider);

      const location = outcome.headers.location;
      const isRedirect =
        REDIRECT_STATUSES.has(outcome.status) &&
        typeof location === 'string' &&
        location.length > 0;

      if (isRedirect && hop >= maxRedirects) {
        // Mirrors `fetch`, which raises rather than reporting an unfollowed
        // redirect as a successful delivery. A redirect loop is a real
        // misconfiguration, not a 2xx.
        cleanup();
        throw new Error(
          `Webhook redirect limit of ${maxRedirects} exceeded starting at ${options.url}`,
        );
      }

      if (!isRedirect) {
        cleanup();
        return {
          response: buildResponse(
            outcome.status,
            outcome.statusText,
            toHeaders(outcome.headers),
            outcome.body,
          ),
          timings: outcome.timings,
          finalUrl: currentUrl,
          redirects,
          reusedConnection: outcome.reusedConnection,
        };
      }

      const nextUrl = resolveRedirect(currentUrl, location);
      if (options.onRedirect) {
        await options.onRedirect(currentUrl, nextUrl);
      }
      redirects.push(nextUrl);

      // Match the fetch spec: 303 always downgrades to GET, and 301/302 do so
      // for POST. 307/308 replay the request as-is.
      const downgrades =
        outcome.status === 303 ||
        ((outcome.status === 301 || outcome.status === 302) && method === 'POST');

      if (downgrades) {
        method = method === 'HEAD' ? 'HEAD' : 'GET';
        body = undefined;
        headers = Object.fromEntries(
          Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())),
        );
      }

      currentUrl = nextUrl;
    }
  } catch (err) {
    cleanup();
    if (isTimedOut()) {
      throw new ExternalRequestTimeoutError(
        `Request to ${provider} (${options.url}) timed out after ${timeoutMs}ms`,
        { provider, timeoutMs, url: options.url },
      );
    }
    throw err;
  }
}

/**
 * Fallback used when the native transport is disabled or the URL cannot be
 * handled by it. Keeps the TTFB and response-stream numbers — the two phases
 * that matter most — and reports DNS/TCP/TLS as unobserved, because undici
 * gives us no way to measure them.
 */
export async function fetchWithPhaseTimings(
  options: WebhookHttpRequestOptions,
): Promise<WebhookHttpRequestResult> {
  const timer = new HttpPhaseTimer();
  const init: RequestInit = {
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
  };
  if (options.body !== undefined) {
    init.body = options.body;
  }

  const response = await fetchWithTimeout(
    options.url,
    init,
    options.timeoutMs ?? 10000,
    options.signal,
    'Webhook',
  );

  timer.mark(HTTP_PHASE_TTFB);
  const text = await response.text();
  timer.mark(HTTP_PHASE_RESPONSE_STREAM);
  timer.finish();

  // `new Response(body, ...)` throws for null-body statuses, so hand those a
  // `null` body rather than the (empty) text we just read.
  const nullBodyStatus =
    response.status === 204 || response.status === 205 || response.status === 304;

  return {
    response: new Response(nullBodyStatus ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    timings: timer.durations(),
    finalUrl: options.url,
    redirects: [],
    reusedConnection: false,
  };
}

export interface InstrumentedWebhookRequestOptions extends WebhookHttpRequestOptions {
  webhookId: string;
  /** 1-based delivery attempt, surfaced on the span. */
  attempt?: number;
}

export interface InstrumentedWebhookAttempt extends WebhookHttpRequestResult {
  outcome: WebhookDispatchOutcome;
  /** Status the response carried, or `null` when the request never completed. */
  status: number | null;
}

/** True when the request should be made without a fresh socket when possible. */
export function useNativePhaseTimingTransport(): boolean {
  return env.WEBHOOK_DISPATCH_TRANSPORT === 'native';
}

export function isWebhookDispatchTelemetryEnabled(): boolean {
  return envFlag(env.WEBHOOK_DISPATCH_TELEMETRY_ENABLED, true);
}

/** Maps a completed response to its terminal delivery outcome. */
export function classifyWebhookResponse(status: number): WebhookDispatchOutcome {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'delivered';
}

/** Maps a thrown transport failure to its terminal delivery outcome. */
export function classifyWebhookError(error: unknown): WebhookDispatchOutcome {
  const name = (error as { name?: string } | null)?.name;
  if (error instanceof ExternalRequestTimeoutError) return 'timeout';
  if (name === 'AbortError' || name === 'TimeoutError' || name === 'ETIMEDOUT' || name === 'UND_ERR_HEADERS_TIMEOUT') {
    return 'timeout';
  }
  return 'connection_error';
}

function bodyByteLength(response: Response): number | null {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const parsed = Number.parseInt(declared, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Performs one instrumented webhook delivery attempt.
 *
 * Responsibilities, in order:
 *  1. inject the active W3C trace context onto the outbound request, so the
 *     customer's endpoint can correlate the delivery with this trace;
 *  2. open a `webhook.dispatch` client span parented to the producing job;
 *  3. issue the request over the configured transport;
 *  4. record phase timings, status class and outcome on the span and in
 *     Prometheus;
 *  5. always close the span and the in-flight gauge, including on throw.
 *
 * When `WEBHOOK_DISPATCH_TELEMETRY_ENABLED=false` this degrades to a plain
 * request with no span, no metrics and no injected headers — the documented
 * rollback path.
 */
export async function sendInstrumentedWebhookRequest(
  options: InstrumentedWebhookRequestOptions,
): Promise<InstrumentedWebhookAttempt> {
  const instrumented = isWebhookDispatchTelemetryEnabled();
  const requestHeaders: Record<string, string> = { ...(options.headers ?? {}) };
  if (instrumented) {
    injectTraceContext(requestHeaders);
  }

  const request: WebhookHttpRequestOptions = {
    ...options,
    headers: requestHeaders,
    maxRedirects: options.maxRedirects ?? env.WEBHOOK_DISPATCH_MAX_REDIRECTS,
  };

  if (!instrumented) {
    const result = useNativePhaseTimingTransport()
      ? await requestWithPhaseTimings(request)
      : await fetchWithPhaseTimings(request);
    return {
      ...result,
      status: result.response.status,
      outcome: classifyWebhookResponse(result.response.status),
    };
  }

  const span = startWebhookDispatchSpan();
  webhookDispatchMetrics.beginAttempt();

  try {
    const result = useNativePhaseTimingTransport()
      ? await requestWithPhaseTimings(request)
      : await fetchWithPhaseTimings(request);

    const status = result.response.status;
    const outcome = classifyWebhookResponse(status);
    const responseBytes = bodyByteLength(result.response);

    finalizeWebhookDispatchSpan(span, {
      webhookId: options.webhookId,
      url: result.finalUrl,
      method: (options.method ?? 'POST').toUpperCase(),
      status,
      responseBytes,
      attempt: options.attempt ?? null,
      timings: result.timings,
      outcome,
    });
    span.setAttribute('webhook.redirects', result.redirects.length);
    span.setAttribute('webhook.connection.reused', result.reusedConnection);

    webhookDispatchMetrics.record({ timings: result.timings, outcome, status });

    return { ...result, status, outcome };
  } catch (error) {
    const outcome = classifyWebhookError(error);
    finalizeWebhookDispatchSpan(span, {
      webhookId: options.webhookId,
      url: options.url,
      method: (options.method ?? 'POST').toUpperCase(),
      status: null,
      responseBytes: null,
      attempt: options.attempt ?? null,
      timings: null,
      outcome,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    webhookDispatchMetrics.record({ timings: null, outcome, status: null });
    throw error;
  } finally {
    webhookDispatchMetrics.endAttempt();
    span.end();
  }
}
