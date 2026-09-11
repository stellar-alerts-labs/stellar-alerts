/**
 * Browser origins allowed to call the API. APP_URL holds the dashboard origin
 * and accepts a comma-separated list so a deployment can serve several fronts
 * (production domain plus preview URLs) without code changes.
 */
export function parseAllowedOrigins(appUrl: string): string[] {
  const origins = appUrl
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(normalizeOrigin)
    .filter((entry): entry is string => entry !== null);

  return [...new Set(origins)];
}

// Compares scheme, host and port only; a trailing path or slash on APP_URL
// would never match the Origin header a browser actually sends.
function normalizeOrigin(entry: string): string | null {
  try {
    return new URL(entry).origin;
  } catch {
    console.warn(`[CORS] Ignoring malformed origin in APP_URL: "${entry}"`);
    return null;
  }
}

export type OriginValidator = (
  origin: string | undefined,
  callback: (error: Error | null, allow: boolean) => void
) => void;

/**
 * Builds the @fastify/cors origin callback. Requests without an Origin header
 * (curl, server-to-server, health probes) are not browser cross-origin requests
 * and are allowed through; anything else must be on the whitelist.
 */
export function createOriginValidator(allowedOrigins: string[]): OriginValidator {
  return (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    console.warn(`[CORS] Rejected cross-origin request from "${origin}"`);
    callback(null, false);
  };
}
