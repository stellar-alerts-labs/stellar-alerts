import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env', () => ({
  env: { CSRF_ALLOWED_ORIGINS: 'https://app.example.com,http://localhost:3000' },
}));

import { isAllowedCsrfOrigin, requiresCsrfProtection } from '../csrf.middleware';

const request = (overrides: Record<string, unknown> = {}) => ({
  method: 'POST',
  headers: { cookie: 'session=token' },
  ...overrides,
}) as never;

describe('CSRF origin protection', () => {
  it('requires an allowed origin for cookie-authenticated mutations', () => {
    expect(requiresCsrfProtection(request())).toBe(true);
    expect(isAllowedCsrfOrigin(request({ headers: { cookie: 'session=token', origin: 'https://app.example.com' } }))).toBe(true);
    expect(isAllowedCsrfOrigin(request({ headers: { cookie: 'session=token', origin: 'https://attacker.example' } }))).toBe(false);
  });

  it('preserves bearer-token clients and non-mutating requests', () => {
    expect(requiresCsrfProtection(request({ headers: { authorization: 'Bearer api-token', cookie: 'session=token' } }))).toBe(false);
    expect(requiresCsrfProtection(request({ method: 'GET' }))).toBe(false);
  });

  it('accepts an allowed referer when Origin is absent', () => {
    expect(isAllowedCsrfOrigin(request({ headers: { cookie: 'session=token', referer: 'https://app.example.com/settings' } }))).toBe(true);
  });
});