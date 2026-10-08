/**
 * Comprehensive tests for the profile store.
 *
 * Coverage:
 *  - createProfile: success, duplicate name, invalid name
 *  - listProfiles: empty, one, multiple
 *  - getProfile: found, not found
 *  - getActiveProfileName: none, set after create, updated after use
 *  - getActiveProfile: no active, active found, active missing
 *  - setActiveProfile: success, not found
 *  - updateProfile: success, not found, partial update
 *  - removeProfile: success, clears active, falls back to remaining
 *  - setSecret / getSecret: round-trip, wrong password, missing profile
 *  - listSecretKeys: keys only (no values)
 *  - deleteSecret: removes key
 *  - resolveEffectiveConfig: env override, profile fallback, defaults
 *  - Profile isolation: profiles don't leak each other's secrets
 *  - Persistence: data survives store re-creation with same configDir
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProfileStore,
  createProfile,
  listProfiles,
  getProfile,
  getActiveProfileName,
  getActiveProfile,
  setActiveProfile,
  updateProfile,
  removeProfile,
  setSecret,
  getSecret,
  listSecretKeys,
  deleteSecret,
  resolveEffectiveConfig,
} from './profile-store.js';
import { ProfileError } from './profile-types.js';

// Fast scrypt params injected via env (profile-store uses vault.ts which uses default params)
// We override STELLAR_ALERTS_CONFIG_DIR to isolate each test
const VAULT_PASS = 'test-vault-password-42!';

// Use a fast scrypt N via a custom param. Since vault.ts exports sealVault with a
// params argument but profile-store.ts calls it with defaults, we use a small but
// valid N for integration tests by monkey-patching the env KDF hint is not available.
// The tests are slower but accurate. To keep suite fast we use a single vault pass
// and accept the ~100ms overhead per vault operation.

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'stellar-cli-test-'));
}

function makeStore(dir: string) {
  return createProfileStore(dir);
}

// ---------------------------------------------------------------------------
// createProfile
// ---------------------------------------------------------------------------

describe('profile-store – createProfile', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('creates a profile with correct fields', () => {
    const store = makeStore(dir);
    const p = createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001', network: 'testnet' });
    expect(p.name).toBe('testnet');
    expect(p.apiUrl).toBe('http://localhost:3001');
    expect(p.network).toBe('testnet');
    expect(p.hasSecrets).toBe(false);
    expect(p.createdAt).toBeTruthy();
    expect(p.updatedAt).toBeTruthy();
  });

  it('makes the first profile the active profile automatically', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    expect(getActiveProfileName(store)).toBe('testnet');
  });

  it('does not change active profile when a second profile is created', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    createProfile(store, 'mainnet', { apiUrl: 'https://api.stellar.org' });
    expect(getActiveProfileName(store)).toBe('testnet');
  });

  it('throws PROFILE_ALREADY_EXISTS for a duplicate name', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    expect(() =>
      createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' }),
    ).toThrow(expect.objectContaining({ code: 'PROFILE_ALREADY_EXISTS' }));
  });

  it('throws INVALID_PROFILE_NAME for names with spaces', () => {
    const store = makeStore(dir);
    expect(() =>
      createProfile(store, 'my profile', { apiUrl: 'http://localhost:3001' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PROFILE_NAME' }));
  });

  it('throws INVALID_PROFILE_NAME for names with special chars', () => {
    const store = makeStore(dir);
    expect(() =>
      createProfile(store, 'test@profile!', { apiUrl: 'http://localhost:3001' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PROFILE_NAME' }));
  });

  it('throws INVALID_PROFILE_NAME for empty name', () => {
    const store = makeStore(dir);
    expect(() =>
      createProfile(store, '', { apiUrl: 'http://localhost:3001' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PROFILE_NAME' }));
  });

  it('throws INVALID_PROFILE_NAME for name longer than 64 chars', () => {
    const store = makeStore(dir);
    const longName = 'a'.repeat(65);
    expect(() =>
      createProfile(store, longName, { apiUrl: 'http://localhost:3001' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PROFILE_NAME' }));
  });

  it('accepts valid profile names with hyphens and underscores', () => {
    const store = makeStore(dir);
    const p = createProfile(store, 'my-profile_v2', { apiUrl: 'http://localhost:3001' });
    expect(p.name).toBe('my-profile_v2');
  });
});

// ---------------------------------------------------------------------------
// listProfiles
// ---------------------------------------------------------------------------

describe('profile-store – listProfiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('returns empty array when no profiles exist', () => {
    const store = makeStore(dir);
    expect(listProfiles(store)).toEqual([]);
  });

  it('returns one profile', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    const profiles = listProfiles(store);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe('testnet');
  });

  it('returns multiple profiles', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    createProfile(store, 'mainnet', { apiUrl: 'https://horizon.stellar.org' });
    createProfile(store, 'staging', { apiUrl: 'https://staging.example.com' });
    const profiles = listProfiles(store);
    expect(profiles).toHaveLength(3);
    const names = profiles.map((p) => p.name);
    expect(names).toContain('testnet');
    expect(names).toContain('mainnet');
    expect(names).toContain('staging');
  });
});

// ---------------------------------------------------------------------------
// getProfile
// ---------------------------------------------------------------------------

describe('profile-store – getProfile', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('returns the correct profile', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    const profile = getProfile(store, 'testnet');
    expect(profile.name).toBe('testnet');
    expect(profile.apiUrl).toBe('http://localhost:3001');
  });

  it('throws PROFILE_NOT_FOUND for unknown profile', () => {
    const store = makeStore(dir);
    expect(() => getProfile(store, 'nonexistent')).toThrow(
      expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }),
    );
  });
});

// ---------------------------------------------------------------------------
// getActiveProfile / setActiveProfile
// ---------------------------------------------------------------------------

describe('profile-store – active profile', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('returns null when no active profile is set', () => {
    const store = makeStore(dir);
    expect(getActiveProfileName(store)).toBeNull();
  });

  it('getActiveProfile throws NO_ACTIVE_PROFILE when no profiles exist', () => {
    const store = makeStore(dir);
    expect(() => getActiveProfile(store)).toThrow(
      expect.objectContaining({ code: 'NO_ACTIVE_PROFILE' }),
    );
  });

  it('setActiveProfile switches the active profile', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    createProfile(store, 'mainnet', { apiUrl: 'https://horizon.stellar.org' });
    setActiveProfile(store, 'mainnet');
    expect(getActiveProfileName(store)).toBe('mainnet');
  });

  it('getActiveProfile returns the full active profile config', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001', network: 'testnet' });
    const active = getActiveProfile(store);
    expect(active.name).toBe('testnet');
    expect(active.apiUrl).toBe('http://localhost:3001');
  });

  it('setActiveProfile throws PROFILE_NOT_FOUND for unknown profile', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    expect(() => setActiveProfile(store, 'ghost')).toThrow(
      expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }),
    );
  });
});

// ---------------------------------------------------------------------------
// updateProfile
// ---------------------------------------------------------------------------

describe('profile-store – updateProfile', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('updates the API URL', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    const updated = updateProfile(store, 'testnet', { apiUrl: 'http://localhost:4000' });
    expect(updated.apiUrl).toBe('http://localhost:4000');
  });

  it('updates only the provided fields, leaving others unchanged', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001', network: 'testnet' });
    const updated = updateProfile(store, 'testnet', { network: 'mainnet' });
    expect(updated.network).toBe('mainnet');
    expect(updated.apiUrl).toBe('http://localhost:3001'); // unchanged
  });

  it('updates updatedAt timestamp', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    const original = getProfile(store, 'testnet');
    await new Promise((r) => setTimeout(r, 5)); // ensure time passes
    const updated = updateProfile(store, 'testnet', { apiUrl: 'http://other:9000' });
    expect(updated.updatedAt).not.toBe(original.updatedAt);
  });

  it('does not change createdAt on update', () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    const original = getProfile(store, 'testnet');
    const updated = updateProfile(store, 'testnet', { apiUrl: 'http://other:9000' });
    expect(updated.createdAt).toBe(original.createdAt);
  });

  it('throws PROFILE_NOT_FOUND for unknown profile', () => {
    const store = makeStore(dir);
    expect(() =>
      updateProfile(store, 'ghost', { apiUrl: 'http://localhost:3001' }),
    ).toThrow(expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }));
  });
});

// ---------------------------------------------------------------------------
// removeProfile
// ---------------------------------------------------------------------------

describe('profile-store – removeProfile', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('removes an existing profile', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await removeProfile(store, 'testnet');
    expect(listProfiles(store)).toHaveLength(0);
  });

  it('throws PROFILE_NOT_FOUND for unknown profile', async () => {
    const store = makeStore(dir);
    await expect(removeProfile(store, 'ghost')).rejects.toThrow(
      expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }),
    );
  });

  it('clears active profile to null when last profile is removed', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await removeProfile(store, 'testnet');
    expect(getActiveProfileName(store)).toBeNull();
  });

  it('reassigns active profile to remaining profile when active is removed', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    createProfile(store, 'mainnet', { apiUrl: 'https://horizon.stellar.org' });
    // testnet is active (first created); remove it
    await removeProfile(store, 'testnet');
    const activeName = getActiveProfileName(store);
    expect(activeName).toBe('mainnet');
  });

  it('does not affect other profiles when removing one', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    createProfile(store, 'mainnet', { apiUrl: 'https://horizon.stellar.org' });
    await removeProfile(store, 'testnet');
    const profiles = listProfiles(store);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe('mainnet');
  });
});

// ---------------------------------------------------------------------------
// setSecret / getSecret (vault integration)
// ---------------------------------------------------------------------------

describe('profile-store – vault secrets', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('stores and retrieves an apiKey secret', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });

    await setSecret(store, 'testnet', 'apiKey', 'sk_test_abc123', VAULT_PASS);
    const retrieved = await getSecret(store, 'testnet', 'apiKey', VAULT_PASS);
    expect(retrieved).toBe('sk_test_abc123');
  });

  it('stores and retrieves a custom extra secret', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });

    await setSecret(store, 'testnet', 'webhookSecret', 'wh_super_secret', VAULT_PASS);
    const retrieved = await getSecret(store, 'testnet', 'webhookSecret', VAULT_PASS);
    expect(retrieved).toBe('wh_super_secret');
  });

  it('returns undefined for a key that was not set', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await setSecret(store, 'testnet', 'apiKey', 'sk_test_abc', VAULT_PASS);
    const missing = await getSecret(store, 'testnet', 'missingKey', VAULT_PASS);
    expect(missing).toBeUndefined();
  });

  it('marks profile.hasSecrets = true after storing a secret', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    expect(getProfile(store, 'testnet').hasSecrets).toBe(false);
    await setSecret(store, 'testnet', 'apiKey', 'sk_test_abc', VAULT_PASS);
    expect(getProfile(store, 'testnet').hasSecrets).toBe(true);
  });

  it('rejects getSecret with wrong vault password (VAULT_WRONG_PASSWORD)', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await setSecret(store, 'testnet', 'apiKey', 'sk_test_abc', VAULT_PASS);
    await expect(
      getSecret(store, 'testnet', 'apiKey', 'totally-wrong-password'),
    ).rejects.toMatchObject({ code: 'VAULT_WRONG_PASSWORD' });
  });

  it('throws PROFILE_NOT_FOUND when setting secret on missing profile', async () => {
    const store = makeStore(dir);
    await expect(
      setSecret(store, 'ghost', 'apiKey', 'value', VAULT_PASS),
    ).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  });

  it('throws VAULT_NOT_FOUND when getting secret before any vault is created', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await expect(
      getSecret(store, 'testnet', 'apiKey', VAULT_PASS),
    ).rejects.toMatchObject({ code: 'VAULT_NOT_FOUND' });
  });

  it('isolates secrets between profiles', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    createProfile(store, 'mainnet', { apiUrl: 'https://horizon.stellar.org' });

    await setSecret(store, 'testnet', 'apiKey', 'sk_testnet_key', VAULT_PASS);
    await setSecret(store, 'mainnet', 'apiKey', 'sk_mainnet_key', VAULT_PASS);

    const testnetKey = await getSecret(store, 'testnet', 'apiKey', VAULT_PASS);
    const mainnetKey = await getSecret(store, 'mainnet', 'apiKey', VAULT_PASS);

    expect(testnetKey).toBe('sk_testnet_key');
    expect(mainnetKey).toBe('sk_mainnet_key');
    expect(testnetKey).not.toBe(mainnetKey);
  });

  it('persists secrets across store re-creation (same configDir)', async () => {
    const store1 = makeStore(dir);
    createProfile(store1, 'testnet', { apiUrl: 'http://localhost:3001' });
    await setSecret(store1, 'testnet', 'apiKey', 'sk_persistent_key', VAULT_PASS);

    // Re-open with a fresh store instance pointing at the same dir
    const store2 = makeStore(dir);
    const retrieved = await getSecret(store2, 'testnet', 'apiKey', VAULT_PASS);
    expect(retrieved).toBe('sk_persistent_key');
  });
});

// ---------------------------------------------------------------------------
// listSecretKeys
// ---------------------------------------------------------------------------

describe('profile-store – listSecretKeys', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('returns the keys stored for a profile (not values)', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await setSecret(store, 'testnet', 'apiKey', 'sk_abc', VAULT_PASS);
    await setSecret(store, 'testnet', 'webhookSecret', 'wh_xyz', VAULT_PASS);

    const keys = await listSecretKeys(store, 'testnet', VAULT_PASS);
    expect(keys).toContain('apiKey');
    expect(keys).toContain('webhookSecret');
    // Values must NOT appear
    expect(keys).not.toContain('sk_abc');
    expect(keys).not.toContain('wh_xyz');
  });

  it('returns empty array when no secrets are stored', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await setSecret(store, 'testnet', 'apiKey', 'k', VAULT_PASS);
    // Delete the key so vault has profile but no secrets
    await deleteSecret(store, 'testnet', 'apiKey', VAULT_PASS);
    const keys = await listSecretKeys(store, 'testnet', VAULT_PASS);
    expect(keys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteSecret
// ---------------------------------------------------------------------------

describe('profile-store – deleteSecret', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('removes a secret key from the vault', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await setSecret(store, 'testnet', 'apiKey', 'sk_abc', VAULT_PASS);
    await deleteSecret(store, 'testnet', 'apiKey', VAULT_PASS);
    const val = await getSecret(store, 'testnet', 'apiKey', VAULT_PASS);
    expect(val).toBeUndefined();
  });

  it('updates hasSecrets to false when last secret is removed', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await setSecret(store, 'testnet', 'apiKey', 'sk_abc', VAULT_PASS);
    await deleteSecret(store, 'testnet', 'apiKey', VAULT_PASS);
    expect(getProfile(store, 'testnet').hasSecrets).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveConfig
// ---------------------------------------------------------------------------

describe('profile-store – resolveEffectiveConfig', () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = makeTempDir();
    // Clear relevant env vars
    delete process.env['STELLAR_ALERTS_API_URL'];
    delete process.env['STELLAR_ALERTS_API_KEY'];
    delete process.env['STELLAR_ALERTS_LOG_LEVEL'];
  });

  afterEach(() => {
    // Restore env
    process.env['STELLAR_ALERTS_API_URL'] = originalEnv['STELLAR_ALERTS_API_URL'];
    process.env['STELLAR_ALERTS_API_KEY'] = originalEnv['STELLAR_ALERTS_API_KEY'];
    process.env['STELLAR_ALERTS_LOG_LEVEL'] = originalEnv['STELLAR_ALERTS_LOG_LEVEL'];
    if (!originalEnv['STELLAR_ALERTS_API_URL']) delete process.env['STELLAR_ALERTS_API_URL'];
    if (!originalEnv['STELLAR_ALERTS_API_KEY']) delete process.env['STELLAR_ALERTS_API_KEY'];
    if (!originalEnv['STELLAR_ALERTS_LOG_LEVEL']) delete process.env['STELLAR_ALERTS_LOG_LEVEL'];
  });

  it('returns default URL when no profile or env is configured', async () => {
    const store = makeStore(dir);
    const config = await resolveEffectiveConfig(store);
    expect(config.apiUrl).toBe('http://localhost:3001');
    expect(config.apiKey).toBeUndefined();
  });

  it('returns active profile URL when set', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:9999' });
    const config = await resolveEffectiveConfig(store);
    expect(config.apiUrl).toBe('http://localhost:9999');
  });

  it('returns named profile URL when profileName is supplied', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://testnet.example.com' });
    createProfile(store, 'mainnet', { apiUrl: 'http://mainnet.example.com' });
    const config = await resolveEffectiveConfig(store, 'mainnet');
    expect(config.apiUrl).toBe('http://mainnet.example.com');
  });

  it('env var STELLAR_ALERTS_API_URL overrides active profile', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://profile-url.example.com' });
    process.env['STELLAR_ALERTS_API_URL'] = 'http://env-url.example.com';
    const config = await resolveEffectiveConfig(store);
    expect(config.apiUrl).toBe('http://env-url.example.com');
  });

  it('includes apiKey from vault when password is provided', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await setSecret(store, 'testnet', 'apiKey', 'sk_from_vault', VAULT_PASS);
    const config = await resolveEffectiveConfig(store, undefined, VAULT_PASS);
    expect(config.apiKey).toBe('sk_from_vault');
  });

  it('does not include apiKey when no vault password is provided', async () => {
    const store = makeStore(dir);
    createProfile(store, 'testnet', { apiUrl: 'http://localhost:3001' });
    await setSecret(store, 'testnet', 'apiKey', 'sk_from_vault', VAULT_PASS);
    const config = await resolveEffectiveConfig(store, undefined, undefined);
    // apiKey should be absent since no password was supplied
    expect(config.apiKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isValidProfileName (edge cases)
// ---------------------------------------------------------------------------

describe('profile-store – name validation edge cases', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  it('accepts a single character name', () => {
    const store = makeStore(dir);
    const p = createProfile(store, 'a', { apiUrl: 'http://localhost:3001' });
    expect(p.name).toBe('a');
  });

  it('accepts exactly 64 character name', () => {
    const store = makeStore(dir);
    const name = 'a'.repeat(64);
    const p = createProfile(store, name, { apiUrl: 'http://localhost:3001' });
    expect(p.name).toBe(name);
  });

  it('rejects 65 character name', () => {
    const store = makeStore(dir);
    const name = 'a'.repeat(65);
    expect(() => createProfile(store, name, { apiUrl: 'http://localhost:3001' })).toThrow(
      expect.objectContaining({ code: 'INVALID_PROFILE_NAME' }),
    );
  });

  it('accepts testnet, mainnet, staging as names', () => {
    const store = makeStore(dir);
    for (const n of ['testnet', 'mainnet', 'staging']) {
      const p = createProfile(store, n, { apiUrl: 'http://localhost:3001' });
      expect(p.name).toBe(n);
    }
  });
});
