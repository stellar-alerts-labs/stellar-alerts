import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../config/env', () => ({
  env: {
    DATABASE_URL: 'postgresql://user:password@localhost:5432/stellar_alerts',
    TELEGRAM_BOT_TOKEN: 'test-token',
    JWT_SECRET: 'test-secret',
    REDIS_URL: 'redis://localhost:6379',
    PORT: '3001',
    APP_URL: 'http://localhost:3000',
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
  },
}));

import { buildApp } from '../app';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const FOREIGN_ORIGIN = 'https://evil.example';

describe('CORS and security headers', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('preflight', () => {
    it('answers a preflight from the whitelisted origin with that origin', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/wallets',
        headers: {
          origin: ALLOWED_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('Authorization');
      expect(response.headers['access-control-max-age']).toBe('86400');
    });

    it('never answers with a wildcard origin', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/wallets',
        headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' },
      });

      expect(response.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('varies on Origin so caches cannot serve one origin the answer for another', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/wallets',
        headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' },
      });

      expect(response.headers.vary).toContain('Origin');
    });

    it('withholds CORS headers from a preflight sent by a foreign origin', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/wallets',
        headers: { origin: FOREIGN_ORIGIN, 'access-control-request-method': 'POST' },
      });

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('simple requests', () => {
    it('sends the allow-origin header back to the whitelisted origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: ALLOWED_ORIGIN },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    });

    it('withholds the allow-origin header from a foreign origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: FOREIGN_ORIGIN },
      });

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('serves same-origin and server-to-server requests that carry no Origin header', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });
  });

  describe('security headers', () => {
    it('sets the hardened header set on API responses', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
      expect(response.headers['strict-transport-security']).toContain('max-age=15552000');
    });

    it('locks the API content security policy down to same-origin', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      const csp = response.headers['content-security-policy'] as string;

      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
    });

    it('leaves the Swagger UI its own policy so the docs still render', async () => {
      const docs = await app.inject({ method: 'GET', url: '/docs' });
      const asset = await app.inject({ method: 'GET', url: '/docs/static/swagger-ui.css' });

      expect(docs.statusCode).toBe(200);
      expect(asset.statusCode).toBe(200);
      expect(docs.headers['content-security-policy']).toContain('validator.swagger.io');
    });
  });
});
