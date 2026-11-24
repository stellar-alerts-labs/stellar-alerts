/**
 * Outbound transport guard for webhook dispatch.
 *
 * Node's HTTP client does not follow redirects on its own, but a subscriber
 * can still answer 3xx with a `Location` pointing at an internal address.
 * This guard keeps redirect handling explicit: every hop is re-validated
 * against the SSRF policy and HTTPS-only rule, failed redirect hops quarantine
 * the originating endpoint and emit a critical security event, and response
 * bodies are capped and watched for slow drip ("slowloris") transfers.
 *
 * All side effects are injectable so the guard is unit-testable without
 * network, Redis, or PostgreSQL.
 */

import { createLogger } from '../../lib/logger';
import { redisCache } from '../../lib/redis';
import {
  SsrfValidationError,
  validateUrlForSsrf,
  type SsrfValidationOptions,
} from '../../utils/ssrf';

export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
export const DEFAULT_MIN_BYTE_RATE_BYTES_PER_SECOND = 64;
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_STALL_GRACE_MS = 2_000;
export const QUARANTINE_TTL_SECONDS = 24 * 60 * 60;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const log = createLogger({ module: 'TransportGuard' });

export type TransportGuardErrorCode =
  | 'INVALID_URL'
  | 'HTTPS_REQUIRED'
  | 'REDIRECT_BLOCKED'
  | 'MAX_REDIRECTS_EXCEEDED'
  | 'MISSING_REDIRECT_LOCATION'
  | 'RESPONSE_TOO_LARGE'
  | 'TRANSFER_STALLED';

export class TransportGuardError extends Error {
  constructor(
    public readonly code: TransportGuardErrorCode,
    message: string,
    public readonly url: string,
  ) {
    super(`[TransportGuard] ${message} (URL: ${url})`);
    this.name = 'TransportGuardError';
  }
}

export interface GuardedRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Forwarded to the instrumented dispatcher transport for tracing. */
  traceparent?: string;
}

export interface GuardedResponse {
  status: number;
  ok?: boolean;
  headers: Pick<Headers, 'get'>;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type GuardedTransport = (
  url: string,
  init: GuardedRequestInit & { redirect: 'manual' },
) => Promise<GuardedResponse>;

export interface TransportSecurityEvent {
  severity: 'critical';
  code: string;
  message: string;
  url: string;
  redirectUrl?: string;
  at: string;
}

export interface UrlValidation {
  url: URL;
  resolvedIps: string[];
}

export interface TransportGuardOptions {
  transport?: GuardedTransport;
  validateUrl?: (url: string) => Promise<UrlValidation>;
  /** Set false when the caller already validated the initial URL (dispatcher). */
  validateInitialUrl?: boolean;
  onSecurityEvent?: (event: TransportSecurityEvent) => void | Promise<void>;
  quarantine?: (url: string, reason: string) => void | Promise<void>;
  maxRedirects?: number;
  maxResponseBytes?: number;
  minByteRateBytesPerSecond?: number;
  stallGraceMs?: number;
  now?: () => number;
}

export function quarantineKey(url: string): string {
  let host = url;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    // Keep an unparseable URL verbatim rather than losing the quarantine key.
  }
  return `webhook_quarantine:${host}`;
}

/** Redis-backed quarantine used by the live dispatcher. */
export async function quarantineEndpoint(url: string, reason: string): Promise<void> {
  await redisCache.set(quarantineKey(url), reason, QUARANTINE_TTL_SECONDS);
}

export async function isEndpointQuarantined(url: string): Promise<boolean> {
  return (await redisCache.get(quarantineKey(url))) !== null;
}

export function defaultOnSecurityEvent(event: TransportSecurityEvent): void {
  log.fatal(event, `CRITICAL security event: ${event.message}`);
}

/** Default transport: explicit manual redirects, no automatic following. */
export const fetchTransport: GuardedTransport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: 'manual',
  });
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body: response.body,
    text: () => response.text(),
  };
};

function assertHttpsOnly(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportGuardError('INVALID_URL', 'Malformed destination URL', url);
  }
  if (parsed.protocol !== 'https:') {
    throw new TransportGuardError(
      'HTTPS_REQUIRED',
      `Only HTTPS destinations are allowed (got ${parsed.protocol})`,
      url,
    );
  }
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new TransportGuardError(
          'TRANSFER_STALLED',
          `Response transfer stalled for more than ${timeoutMs}ms`,
          url,
        ),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Consumes the response body under the configured size and rate limits and
 * returns a response whose `text()` yields the buffered body. Consuming the
 * stream here is what lets the guard abort mid-transfer on a drip attack.
 */
async function enforceBodyLimits(
  response: GuardedResponse,
  url: string,
  maxResponseBytes: number,
  minByteRateBytesPerSecond: number,
  stallGraceMs: number,
  now: () => number,
): Promise<GuardedResponse> {
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new TransportGuardError(
      'RESPONSE_TOO_LARGE',
      `Declared response size ${declaredLength} exceeds ${maxResponseBytes} bytes`,
      url,
    );
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const bodyText = await response.text();
    if (Buffer.byteLength(bodyText, 'utf8') > maxResponseBytes) {
      throw new TransportGuardError(
        'RESPONSE_TOO_LARGE',
        `Response body exceeds ${maxResponseBytes} bytes`,
        url,
      );
    }
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = now();
  let totalBytes = 0;
  let bodyText = '';

  try {
    while (true) {
      // At a 64 B/s floor, allow 8s without a chunk. Faster floors tighten
      // the gap proportionally, with a 200ms lower bound for testability.
      const gapTimeoutMs =
        minByteRateBytesPerSecond > 0
          ? Math.max(200, Math.ceil((512 / minByteRateBytesPerSecond) * 1000))
          : 30_000;
      const chunk = await raceWithTimeout(reader.read(), gapTimeoutMs, url);
      if (chunk.done) break;

      const bytes = chunk.value?.byteLength ?? 0;
      totalBytes += bytes;
      bodyText += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });

      if (totalBytes > maxResponseBytes) {
        throw new TransportGuardError(
          'RESPONSE_TOO_LARGE',
          `Response body exceeded ${maxResponseBytes} bytes`,
          url,
        );
      }

      const elapsedMs = now() - startedAt;
      if (
        minByteRateBytesPerSecond > 0 &&
        elapsedMs >= stallGraceMs &&
        totalBytes / (elapsedMs / 1000) < minByteRateBytesPerSecond
      ) {
        throw new TransportGuardError(
          'TRANSFER_STALLED',
          `Transfer rate ${(totalBytes / (elapsedMs / 1000)).toFixed(1)} B/s is below the ${minByteRateBytesPerSecond} B/s minimum`,
          url,
        );
      }
    }
    bodyText += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body: null,
    text: async () => bodyText,
  };
}

/**
 * Builds a guarded transport. Redirects are disabled at the underlying
 * transport and handled here one hop at a time, with SSRF re-validation.
 */
export function createGuardedTransport(options: TransportGuardOptions = {}): GuardedTransport {
  const transport = options.transport ?? fetchTransport;
  const validateUrl =
    options.validateUrl ??
    ((url: string) => validateUrlForSsrf(url, { allowHttp: false }));
  const validateInitialUrl = options.validateInitialUrl ?? true;
  const onSecurityEvent = options.onSecurityEvent ?? defaultOnSecurityEvent;
  const quarantine = options.quarantine ?? quarantineEndpoint;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const minByteRateBytesPerSecond =
    options.minByteRateBytesPerSecond ?? DEFAULT_MIN_BYTE_RATE_BYTES_PER_SECOND;
  const stallGraceMs = options.stallGraceMs ?? DEFAULT_STALL_GRACE_MS;
  const now = options.now ?? Date.now;

  return async function guardedFetch(url, init): Promise<GuardedResponse> {
    const originatingUrl = url;
    let currentUrl = url;
    let hops = 0;

    while (true) {
      assertHttpsOnly(currentUrl);
      if (validateInitialUrl || hops > 0) {
        await validateUrl(currentUrl);
      }

      const response = await transport(currentUrl, { ...init, redirect: 'manual' });

      if (REDIRECT_STATUSES.has(response.status)) {
        if (hops >= maxRedirects) {
          throw new TransportGuardError(
            'MAX_REDIRECTS_EXCEEDED',
            `Redirect limit (${maxRedirects}) exceeded`,
            currentUrl,
          );
        }
        const location = response.headers.get('location');
        if (!location) {
          throw new TransportGuardError(
            'MISSING_REDIRECT_LOCATION',
            'Redirect response has no Location header',
            currentUrl,
          );
        }

        hops++;
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
          assertHttpsOnly(nextUrl);
          await validateUrl(nextUrl);
        } catch (error: unknown) {
          const reason =
            error instanceof SsrfValidationError ? error.code : (error as Error)?.message || 'UNKNOWN';
          // Quarantine the origin endpoint: it is the compromised subscriber,
          // even when the dangerous target is the redirect destination.
          await Promise.all([
            quarantine(originatingUrl, reason),
            Promise.resolve(
              onSecurityEvent({
                severity: 'critical',
                code: 'REDIRECT_BLOCKED',
                message: `Webhook endpoint attempted a blocked redirect (${reason})`,
                url: originatingUrl,
                redirectUrl: nextUrl,
                at: new Date(now()).toISOString(),
              }),
            ),
          ]);
          throw new TransportGuardError(
            'REDIRECT_BLOCKED',
            `Redirect target rejected: ${reason}`,
            currentUrl,
          );
        }
        currentUrl = nextUrl;
        continue;
      }

      return enforceBodyLimits(
        response,
        currentUrl,
        maxResponseBytes,
        minByteRateBytesPerSecond,
        stallGraceMs,
        now,
      );
    }
  };
}

/** Ready-to-use guard for callers without a custom transport (e.g. test pings). */
export const guardedWebhookFetch = createGuardedTransport();

export type { SsrfValidationOptions };
