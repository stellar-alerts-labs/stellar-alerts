import { cliEnvSchema, CliEnv, validateProcessEnv, printStartupDiagnostics } from '@stellar-alerts/shared';
import { createProfileStore, resolveEffectiveConfig } from './profile-store.js';

let cachedCliConfig: CliEnv | null = null;

export function getCliConfig(): CliEnv {
  if (!cachedCliConfig) {
    cachedCliConfig = validateProcessEnv(cliEnvSchema, process.env, 'cli', {
      isProduction: false,
    });
  }
  return cachedCliConfig;
}

export function printCliDiagnostics(): string {
  return printStartupDiagnostics('cli', getCliConfig());
}

/**
 * Resolves the effective API URL and key for a CLI invocation.
 *
 * Precedence (highest → lowest):
 *  1. STELLAR_ALERTS_API_URL / STELLAR_ALERTS_API_KEY environment variables
 *  2. Profile named by `--profile` CLI flag (`profileName` arg)
 *  3. Currently active profile (from ~/.config/stellar-alerts/profiles.json)
 *  4. Built-in defaults (http://localhost:3001, no API key)
 *
 * Sensitive values (API key) are loaded from the encrypted vault only when
 * `vaultPassword` is provided.
 */
export async function resolveApiConfig(
  profileName?: string,
  vaultPassword?: string,
): Promise<{ apiUrl: string; apiKey?: string }> {
  const store = createProfileStore();
  const resolved = await resolveEffectiveConfig(store, profileName, vaultPassword);
  return { apiUrl: resolved.apiUrl, apiKey: resolved.apiKey };
}
