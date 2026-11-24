import { describe, it, expect, vi } from 'vitest';
import { SsrfValidationError } from '../../../utils/ssrf';
import {
  TransportGuardError,
  createGuardedTransport,
  quarantineKey,
  type GuardedResponse,
  type TransportGuardOptions,
  type UrlValidation,
} from '../transport-guard';

const ORIGIN = 'https://subscriber.example.com/hook';

function response(
  status: number,
  headers: Record<string, string> = {},
  body = 'ok',
): GuardedResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: null,
    text: async () => body,
  };
}

function urlValidation(url: string): UrlValidation {
  return { url: new URL(url), resolvedIps: ['93.184.216.34'] };
}

function privateTargetValidator(url: string): Promise<UrlValidation> {
  const parsed = new URL(url);
  if (/^127\./.test(parsed.hostname) || parsed.hostname === 'localhost') {
    return Promise.reject(
      new SsrfValidationError('Private/loopback address is not allowed', url, 'PRIVATE_IP'),
    );
  }
  return Promise.resolve(urlValidation(url));
}

function makeGuard(overrides: Partial<TransportGuardOptions> = {}) {
  const defaultTransport = vi.fn(async (url: string) => response(200, {}, `body:${url}`));
  const defaultQuarantine = vi.fn(async () => undefined);
  const defaultOnSecurityEvent = vi.fn();
  const transport = overrides.transport ?? defaultTransport;
  const quarantine = overrides.quarantine ?? defaultQuarantine;
  const onSecurityEvent = overrides.onSecurityEvent ?? defaultOnSecurityEvent;
  const guard = createGuardedTransport({
    validateUrl: async (url) => privateTargetValidator(url),
    now: () => Date.parse('2026-11-24T14:00:00Z'),
    ...overrides,
    transport,
    quarantine,
    onSecurityEvent,
  });
  return { guard, transport, quarantine, onSecurityEvent };
}

describe('HTTPS-only policy', () => {
  it('rejects a plaintext destination before issuing any request', async () => {
    const { guard, transport } = makeGuard();
    await expect(
      guard('http://subscriber.example.com/hook', { redirect: 'manual' }),
    ).rejects.toMatchObject({
      code: 'HTTPS_REQUIRED',
      name: 'TransportGuardError',
    } as Partial<TransportGuardError>);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('manual redirects', () => {
  it('blocks a 307 redirect to 127.0.0.1, quarantines the origin and emits a critical event', async () => {
    const privateTarget = 'https://127.0.0.1:8443/admin';
    const transport = vi.fn(async (url: string) =>
      url === ORIGIN
        ? response(307, { location: privateTarget }, '')
        : response(200, {}, 'should-never-arrive'),
    );
    const quarantine = vi.fn(async () => undefined);
    const onSecurityEvent = vi.fn();
    const guard = createGuardedTransport({
      transport,
      validateUrl: async (url) => privateTargetValidator(url),
      quarantine,
      onSecurityEvent,
      now: () => Date.parse('2026-11-24T14:00:00Z'),
    });

    await expect(guard(ORIGIN, { redirect: 'manual' })).rejects.toMatchObject({
      code: 'REDIRECT_BLOCKED',
      message: expect.stringContaining('PRIVATE_IP'),
    });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalledWith(privateTarget, expect.anything());
    expect(quarantine).toHaveBeenCalledWith(ORIGIN, 'PRIVATE_IP');
    expect(onSecurityEvent).toHaveBeenCalledWith({
      severity: 'critical',
      code: 'REDIRECT_BLOCKED',
      message: expect.stringContaining('PRIVATE_IP'),
      url: ORIGIN,
      redirectUrl: privateTarget,
      at: new Date(Date.parse('2026-11-24T14:00:00Z')).toISOString(),
    });
  });

  it('follows a safe HTTPS redirect and re-validates each hop', async () => {
    const NEXT = 'https://cdn.example.com/hook';
    const transport = vi.fn(async (url: string) =>
      url === ORIGIN ? response(307, { location: NEXT }, '') : response(200, {}, 'final'),
    );
    const validateUrl = vi.fn(async (url: string) => privateTargetValidator(url));
    const quarantine = vi.fn(async () => undefined);
    const onSecurityEvent = vi.fn();
    const guard = createGuardedTransport({
      transport,
      validateUrl,
      quarantine,
      onSecurityEvent,
    });

    const res = await guard(ORIGIN, { redirect: 'manual' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('final');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(validateUrl).toHaveBeenCalledWith(ORIGIN);
    expect(validateUrl).toHaveBeenCalledWith(NEXT);
    expect(quarantine).not.toHaveBeenCalled();
    expect(onSecurityEvent).not.toHaveBeenCalled();
  });

  it('enforces the redirect limit and rejects a missing Location header', async () => {
    const looping = makeGuard({
      transport: vi.fn(async () => response(302, { location: ORIGIN }, '')),
      maxRedirects: 2,
    });
    await expect(looping.guard(ORIGIN, { redirect: 'manual' })).rejects.toMatchObject({
      code: 'MAX_REDIRECTS_EXCEEDED',
    });
    expect(looping.transport).toHaveBeenCalledTimes(3); // initial + 2 hops

    const missing = makeGuard({ transport: vi.fn(async () => response(307, {}, '')) });
    await expect(missing.guard(ORIGIN, { redirect: 'manual' })).rejects.toMatchObject({
      code: 'MISSING_REDIRECT_LOCATION',
    });
  });

  it('treats a malformed Location as a blocked redirect rather than throwing a raw URL error', async () => {
    const { guard, quarantine, onSecurityEvent } = makeGuard({
      transport: vi.fn(async () => response(307, { location: 'http://[::1]:8080/' }, '')),
    });
    await expect(guard(ORIGIN, { redirect: 'manual' })).rejects.toMatchObject({
      code: 'REDIRECT_BLOCKED',
    });
    expect(quarantine).toHaveBeenCalledWith(ORIGIN, expect.any(String));
    expect(onSecurityEvent).toHaveBeenCalledTimes(1);
  });
});

describe('response body limits', () => {
  it('rejects an oversized declared content-length before streaming', async () => {
    const { guard } = makeGuard({
      transport: vi.fn(async () =>
        response(200, { 'content-length': String(17 * 1024) }, 'small actual body'),
      ),
    });
    await expect(guard(ORIGIN, { redirect: 'manual' })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('aborts a streamed body that exceeds the 16KB cap', async () => {
    const huge = new Uint8Array(16 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge);
        controller.close();
      },
    });
    const { guard } = makeGuard({
      transport: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        body: stream,
        text: async () => '',
      })),
    });
    await expect(guard(ORIGIN, { redirect: 'manual' })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('aborts a slowloris drip once the average rate drops below the floor', async () => {
    let nowMs = 1_000_000;
    let chunksRemaining = 10;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksRemaining-- <= 0) {
          controller.close();
          return;
        }
        // Advance perceived time by 100ms for each 1-byte chunk: after the
        // grace window the cumulative rate is ~10 B/s, far below the 100 B/s
        // floor, so the guard must abort mid-transfer.
        nowMs += 100;
        controller.enqueue(new Uint8Array(1));
      },
    });
    const { guard } = makeGuard({
      transport: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        body: stream,
        text: async () => '',
      })),
      now: () => nowMs,
      minByteRateBytesPerSecond: 100,
      stallGraceMs: 200,
    });

    await expect(guard(ORIGIN, { redirect: 'manual' })).rejects.toMatchObject({
      code: 'TRANSFER_STALLED',
    });
  });
});

describe('quarantine helpers', () => {
  it('keys quarantine entries by host, not full URL', () => {
    expect(quarantineKey('https://subscriber.example.com/a')).toBe(
      quarantineKey('https://subscriber.example.com/b'),
    );
    expect(quarantineKey('https://subscriber.example.com/a')).toBe(
      'webhook_quarantine:subscriber.example.com',
    );
    expect(quarantineKey('not-a-url')).toBe('webhook_quarantine:not-a-url');
  });
});
