import { NextRequest, NextResponse } from 'next/server';

/**
 * Next.js 16 Proxy (replaces middleware.ts from Next.js ≤15).
 *
 * Responsibilities:
 *  1. Generate a per-request cryptographic nonce and set a strict
 *     Content-Security-Policy header (no 'unsafe-inline' in script-src).
 *  2. Set all remaining security headers: HSTS, X-Frame-Options,
 *     X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
 */

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === 'development';

  // style-src: allow 'unsafe-inline' only in dev (CSS-in-JS / Tailwind injects
  // style tags during development; production builds should use external sheets).
  const styleSrc = isDev
    ? `style-src 'self' 'unsafe-inline';`
    : `style-src 'self' 'nonce-${nonce}';`;

  // script-src: 'strict-dynamic' lets nonce-trusted scripts load further chunks
  // (required for Next.js code splitting). 'unsafe-eval' is only needed in dev
  // because React uses eval for enhanced error stack reconstruction.
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval';`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic';`;

  return [
    "default-src 'self';",
    scriptSrc,
    styleSrc,
    "img-src 'self' blob: data:;",
    "font-src 'self';",
    "connect-src 'self';",
    "object-src 'none';",
    "base-uri 'self';",
    "form-action 'self';",
    "frame-ancestors 'none';",
    "upgrade-insecure-requests;",
  ]
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function proxy(request: NextRequest): NextResponse {
  // Generate a fresh, cryptographically random nonce for this request.
  // crypto.randomUUID() is available on the Next.js edge runtime and Node ≥14.17.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce);

  // Forward the nonce to the rendering layer so Server Components can read it
  // via `headers().get('x-nonce')` and attach it to any <Script> they render.
  const requestHeaders = new Headers(request.headers as any);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  // Security headers applied to every HTML response.
  response.headers.set('Content-Security-Policy', csp);

  // HSTS: 1 year, include sub-domains, allow preload registration.
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload',
  );

  // Deny framing entirely (blocks clickjacking).
  response.headers.set('X-Frame-Options', 'DENY');

  // Prevent MIME-type sniffing.
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Referrer policy: send origin only when navigating same-origin; send nothing
  // to cross-origin destinations to prevent URL leakage.
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy: disable powerful features the app does not use.
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );

  return response;
}

/**
 * Run the proxy on HTML page requests only — skip Next.js internals,
 * static assets, API routes, and prefetch requests to avoid generating
 * wasted nonces and to prevent double-setting headers on non-HTML responses.
 */
export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon\\.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
