import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookSchema } from './webhooks.schema';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createWebhookSchema URL validation', () => {
  it('rejects insecure, credentialed, and disallowed-port targets in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(createWebhookSchema.safeParse({ url: 'https://hooks.example.com/events' }).success).toBe(
      true
    );
    expect(createWebhookSchema.safeParse({ url: 'http://hooks.example.com/events' }).success).toBe(
      false
    );
    expect(
      createWebhookSchema.safeParse({ url: 'https://user:pass@hooks.example.com/events' }).success
    ).toBe(false);
    expect(createWebhookSchema.safeParse({ url: 'https://hooks.example.com:3000/events' }).success).toBe(
      false
    );
  });
});
