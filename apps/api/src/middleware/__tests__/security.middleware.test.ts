import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import { registerSecurityHeaders } from '../security.middleware';

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await registerSecurityHeaders(app);

  app.get('/ping', async () => ({ pong: true }));
  app.get('/custom-csp', async (_req, reply) => {
    // A route that sets its own CSP should not be overwritten.
    reply.header('Content-Security-Policy', "default-src 'self' https://example.com;");
    return { ok: true };
  });

  await app.ready();
  return app;
}

describe('Security headers middleware', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets Strict-Transport-Security with 1-year max-age and includeSubDomains', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const hsts = res.headers['strict-transport-security'] as string;
    expect(hsts).toContain('max-age=31536000');
    expect(hsts).toContain('includeSubDomains');
  });

  it('sets Permissions-Policy disabling camera, mic, geolocation and payment', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const pp = res.headers['permissions-policy'] as string;
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('payment=()');
  });

  it('sets a restrictive Content-Security-Policy on API responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('does not overwrite a CSP header already set by the route handler', async () => {
    const res = await app.inject({ method: 'GET', url: '/custom-csp' });
    expect(res.headers['content-security-policy']).toContain('https://example.com');
  });

  it('removes the X-Powered-By header', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('applies headers to 4xx responses too', async () => {
    const res = await app.inject({ method: 'GET', url: '/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
