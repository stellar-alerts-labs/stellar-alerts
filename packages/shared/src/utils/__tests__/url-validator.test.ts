import { describe, expect, it } from 'vitest';
import { validateWebhookTargetUrl } from '../url-validator';

describe('validateWebhookTargetUrl', () => {
  it('accepts HTTPS URLs with standard and approved webhook ports', () => {
    expect(validateWebhookTargetUrl('https://hooks.example.com/events', 'production')).toBe(true);
    expect(validateWebhookTargetUrl('https://hooks.example.com:8443/events', 'production')).toBe(true);
  });

  it('allows HTTP only in development and test', () => {
    expect(validateWebhookTargetUrl('http://localhost:8080/events', 'development')).toBe(true);
    expect(validateWebhookTargetUrl('http://hooks.example.com/events', 'test')).toBe(true);
    expect(validateWebhookTargetUrl('http://hooks.example.com/events', 'production')).toBe(false);
  });

  it('rejects embedded credentials and ports outside the webhook allowlist', () => {
    expect(validateWebhookTargetUrl('https://user:pass@hooks.example.com/events', 'production')).toBe(
      false
    );
    expect(validateWebhookTargetUrl('https://user@hooks.example.com/events', 'production')).toBe(
      false
    );
    expect(validateWebhookTargetUrl('https://hooks.example.com:3000/events', 'production')).toBe(
      false
    );
  });

  it('rejects malformed, unsupported, non-string, and overlong values', () => {
    expect(validateWebhookTargetUrl('not a url', 'production')).toBe(false);
    expect(validateWebhookTargetUrl('ftp://hooks.example.com/events', 'production')).toBe(false);
    expect(validateWebhookTargetUrl(null, 'production')).toBe(false);
    expect(validateWebhookTargetUrl(`https://hooks.example.com/${'a'.repeat(2048)}`, 'production')).toBe(
      false
    );
  });
});
