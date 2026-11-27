export const WEBHOOK_ALLOWED_PORTS = [80, 443, 8080, 8443] as const;
export const MAX_WEBHOOK_URL_LENGTH = 2048;

/**
 * Validates a webhook target URL before it is stored.
 */
export function validateWebhookTargetUrl(
  value: unknown,
  nodeEnv: string | undefined = process.env.NODE_ENV
): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_WEBHOOK_URL_LENGTH) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false;
  }
  if (url.protocol === 'http:' && nodeEnv !== 'development' && nodeEnv !== 'test') {
    return false;
  }
  if (url.username !== '' || url.password !== '') {
    return false;
  }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return WEBHOOK_ALLOWED_PORTS.some((allowedPort) => allowedPort === port);
}
