/**
 * Auth helpers — resolves the API token and base URL using the defined
 * precedence chain:
 *
 *   1. --token CLI flag            (highest priority)
 *   2. Active profile stored token
 *   3. STELLAR_ALERTS_API_KEY env var
 *   4. No token (unauthenticated)  (lowest priority)
 *
 * And for API URL:
 *   1. --api-url CLI flag
 *   2. Active profile's apiUrl
 *   3. STELLAR_ALERTS_API_URL env var / config default
 */

import { getActiveProfile } from './profileManager.js';
import { getToken } from './credentialStore.js';
import { getCliConfig } from './config.js';

export interface ResolvedAuth {
  /** Resolved bearer token, or undefined if none available. */
  token: string | undefined;
  /** Resolved API base URL. */
  apiUrl: string;
  /** Where the token came from (for diagnostics). */
  tokenSource: 'flag' | 'profile' | 'env' | 'none';
  /** Where the URL came from (for diagnostics). */
  urlSource: 'flag' | 'profile' | 'env';
  /** Active profile name if one contributed, otherwise null. */
  activeProfile: string | null;
}

/**
 * Resolves the effective token and API URL from the available sources.
 *
 * @param flagToken   Value passed via --token CLI option (may be undefined).
 * @param flagApiUrl  Value passed via --api-url CLI option (may be undefined).
 */
export function resolveAuth(
  flagToken?: string,
  flagApiUrl?: string
): ResolvedAuth {
  const config = getCliConfig();
  const activeProfile = getActiveProfile();

  // --- Token resolution ---
  let token: string | undefined;
  let tokenSource: ResolvedAuth['tokenSource'] = 'none';

  if (flagToken) {
    token = flagToken;
    tokenSource = 'flag';
  } else if (activeProfile) {
    const stored = getToken(activeProfile.name);
    if (stored) {
      token = stored;
      tokenSource = 'profile';
    }
  }

  if (!token && config.STELLAR_ALERTS_API_KEY) {
    token = config.STELLAR_ALERTS_API_KEY;
    tokenSource = 'env';
  }

  // --- URL resolution ---
  let apiUrl: string;
  let urlSource: ResolvedAuth['urlSource'] = 'env';

  if (flagApiUrl) {
    apiUrl = flagApiUrl;
    urlSource = 'flag';
  } else if (activeProfile) {
    apiUrl = activeProfile.apiUrl;
    urlSource = 'profile';
  } else {
    apiUrl = config.STELLAR_ALERTS_API_URL;
    urlSource = 'env';
  }

  return {
    token,
    apiUrl,
    tokenSource,
    urlSource,
    activeProfile: activeProfile?.name ?? null,
  };
}

/**
 * Convenience: resolve just the token for commands that already have the URL
 * from the parent program options.
 */
export function resolveToken(flagToken?: string): string | undefined {
  return resolveAuth(flagToken).token;
}
