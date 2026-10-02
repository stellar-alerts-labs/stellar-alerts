import * as StellarSdk from 'stellar-sdk';

export type StellarNetworkProfile = 'testnet' | 'mainnet' | 'custom';

export interface StellarNetworkConfig {
  profile: StellarNetworkProfile;
  horizonEndpoints: readonly string[];
  sorobanRpcUrl: string;
  networkPassphrase: string;
}

const TESTNET_HORIZON_ENDPOINTS = [
  'https://horizon-testnet.stellar.org',
  'https://horizon-testnet.publicnode.org',
  'https://horizon-testnet.lobstr.co',
] as const;

const MAINNET_HORIZON_ENDPOINTS = [
  'https://horizon.stellar.org',
  'https://stellar-horizon.publicnode.org',
  'https://horizon.lobstr.co',
] as const;

const TESTNET_SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const MAINNET_SOROBAN_RPC_URL = 'https://soroban.stellar.org';

const BUILTIN_PROFILES: Record<Exclude<StellarNetworkProfile, 'custom'>, StellarNetworkConfig> = {
  testnet: {
    profile: 'testnet',
    horizonEndpoints: TESTNET_HORIZON_ENDPOINTS,
    sorobanRpcUrl: TESTNET_SOROBAN_RPC_URL,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  },
  mainnet: {
    profile: 'mainnet',
    horizonEndpoints: MAINNET_HORIZON_ENDPOINTS,
    sorobanRpcUrl: MAINNET_SOROBAN_RPC_URL,
    networkPassphrase: StellarSdk.Networks.PUBLIC,
  },
};

function readRequired(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required when STELLAR_NETWORK_PROFILE=custom`);
  return trimmed;
}

function validateEndpoint(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials, query, or hash`);
  }

  return parsed.toString().replace(/\/$/, '');
}

function validateAllowedHost(name: string, url: string, allowedHosts: Set<string>): void {
  const hostname = new URL(url).hostname.toLowerCase();
  if (!allowedHosts.has(hostname)) {
    throw new Error(`${name} hostname "${hostname}" is not in STELLAR_CUSTOM_ALLOWED_HOSTS`);
  }
}

export function resolveStellarNetworkProfile(
  input: NodeJS.ProcessEnv = process.env,
): StellarNetworkConfig {
  const profile = (input.STELLAR_NETWORK_PROFILE?.trim().toLowerCase() || 'testnet') as StellarNetworkProfile;
  if (profile === 'testnet' || profile === 'mainnet') return BUILTIN_PROFILES[profile];
  if (profile !== 'custom') {
    throw new Error('STELLAR_NETWORK_PROFILE must be one of: testnet, mainnet, custom');
  }

  const configuredSecondaryHorizons = input.STELLAR_CUSTOM_HORIZON_URLS ||
    [input.HORIZON_URL_NODE2, input.HORIZON_URL_NODE3].filter(Boolean).join(',');
  const horizonEndpoints = [
    validateEndpoint(
      'STELLAR_CUSTOM_HORIZON_URL',
      readRequired('STELLAR_CUSTOM_HORIZON_URL', input.STELLAR_CUSTOM_HORIZON_URL || input.HORIZON_URL),
    ),
    ...(configuredSecondaryHorizons
      ? configuredSecondaryHorizons.split(',').map((url) => validateEndpoint('STELLAR_CUSTOM_HORIZON_URLS', url.trim()))
      : []),
  ];
  const sorobanRpcUrl = validateEndpoint(
    'STELLAR_CUSTOM_SOROBAN_RPC_URL',
    readRequired('STELLAR_CUSTOM_SOROBAN_RPC_URL', input.STELLAR_CUSTOM_SOROBAN_RPC_URL || input.SOROBAN_RPC_URL),
  );
  const networkPassphrase = readRequired(
    'STELLAR_CUSTOM_NETWORK_PASSPHRASE',
    input.STELLAR_CUSTOM_NETWORK_PASSPHRASE || input.STELLAR_NETWORK_PASSPHRASE,
  );
  const allowedHosts = new Set(
    readRequired('STELLAR_CUSTOM_ALLOWED_HOSTS', input.STELLAR_CUSTOM_ALLOWED_HOSTS)
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );

  horizonEndpoints.forEach((url) => validateAllowedHost('STELLAR_CUSTOM_HORIZON_URL', url, allowedHosts));
  validateAllowedHost('STELLAR_CUSTOM_SOROBAN_RPC_URL', sorobanRpcUrl, allowedHosts);

  return { profile, horizonEndpoints, sorobanRpcUrl, networkPassphrase };
}

export const stellarNetwork = resolveStellarNetworkProfile();
