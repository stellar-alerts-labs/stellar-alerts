/**
 * Unit tests for apps/web/proxy.ts (Next.js 16 proxy / CSP middleware).
 *
 * We mock next/server entirely with lightweight shims so these tests run
 * in a plain Node environment without a full Next.js build.
 *
 * vi.mock() is hoisted above all imports by Vitest's transform, so the
 * factory must be self-contained (no references to outer variables).
 */

import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted above all imports — factory must be self-contained.
vi.mock('next/server', () => {
  class _MockHeaders {
    private store = new Map<string, string>();
    constructor(init?: any) {
      if (init && typeof init.forEach === 'function') {
        init.forEach((v: string, k: string) => this.store.set(k.toLowerCase(), v));
      } else if (init && typeof init === 'object') {
        Object.entries(init as Record<string, string>).forEach(([k, v]) =>
          this.store.set(k.toLowerCase(), v),
        );
      }
    }
    set(name: string, value: string) { this.store.set(name.toLowerCase(), value); }
    get(name: string): string | null { return this.store.get(name.toLowerCase()) ?? null; }
    has(name: string): boolean { return this.store.has(name.toLowerCase()); }
    forEach(cb: (v: string, k: string) => void) { this.store.forEach(cb); }
  }

  class _MockNextRequest {
    url: string;
    headers: _MockHeaders;
    constructor(url: string, init?: { headers?: Record<string, string> }) {
      this.url = url;
      this.headers = new _MockHeaders(init?.headers ?? {});
    }
  }

  class _MockNextResponse {
    headers: _MockHeaders;
    constructor() { this.headers = new _MockHeaders(); }
    static next(): _MockNextResponse { return new _MockNextResponse(); }
  }

  return { NextRequest: _MockNextRequest, NextResponse: _MockNextResponse };
});

import { NextRequest as MockNextRequest, NextResponse as MockNextResponse } from 'next/server';
import { proxy } from '../../../proxy';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(url = 'https://app.example.com/', headers: Record<string, string> = {}) {
  return new MockNextRequest(url, { headers });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Next.js 16 proxy — CSP and security headers', () => {
  it('returns a NextResponse', () => {
    const res = proxy(makeRequest());
    expect(res).toBeInstanceOf(MockNextResponse);
  });

  it('sets a Content-Security-Policy header on the response', () => {
    const res = proxy(makeRequest());
    const csp = res.headers.get('content-security-policy');
    expect(csp).not.toBeNull();
    expect(csp!.length).toBeGreaterThan(10);
  });

  it('CSP contains a nonce value and strict-dynamic', () => {
    const res = proxy(makeRequest());
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("'nonce-");
    expect(csp).toContain("'strict-dynamic'");
  });

  it('CSP does not contain unsafe-inline in production', () => {
    const orig = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'production';
    try {
      const res = proxy(makeRequest());
      const csp = res.headers.get('content-security-policy')!;
      // Script-src must NOT have unsafe-inline.
      // (style-src may have it in dev, but we are forcing prod here)
      const scriptSrcPart = csp.split(';').find((d) => d.trim().startsWith('script-src'));
      expect(scriptSrcPart).toBeDefined();
      expect(scriptSrcPart).not.toContain("'unsafe-inline'");
    } finally {
      (process.env as any).NODE_ENV = orig;
    }
  });

  it('CSP contains frame-ancestors none', () => {
    const res = proxy(makeRequest());
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('CSP contains object-src none', () => {
    const res = proxy(makeRequest());
    expect(res.headers.get('content-security-policy')).toContain("object-src 'none'");
  });

  it('generates a unique nonce for every request', () => {
    const csp1 = proxy(makeRequest()).headers.get('content-security-policy')!;
    const csp2 = proxy(makeRequest()).headers.get('content-security-policy')!;
    const nonce1 = csp1.match(/'nonce-([^']+)'/)?.[1];
    const nonce2 = csp2.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce1).toBeDefined();
    expect(nonce2).toBeDefined();
    expect(nonce1).not.toBe(nonce2);
  });

  it('sets HSTS with 1-year max-age and includeSubDomains', () => {
    const hsts = proxy(makeRequest()).headers.get('strict-transport-security')!;
    expect(hsts).toContain('max-age=31536000');
    expect(hsts).toContain('includeSubDomains');
  });

  it('sets X-Frame-Options: DENY', () => {
    expect(proxy(makeRequest()).headers.get('x-frame-options')).toBe('DENY');
  });

  it('sets X-Content-Type-Options: nosniff', () => {
    expect(proxy(makeRequest()).headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets Referrer-Policy: strict-origin-when-cross-origin', () => {
    expect(proxy(makeRequest()).headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
  });

  it('sets Permissions-Policy disabling camera, mic, geolocation, payment', () => {
    const pp = proxy(makeRequest()).headers.get('permissions-policy')!;
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('payment=()');
  });
});
