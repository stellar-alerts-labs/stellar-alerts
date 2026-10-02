import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Isolate profile store in a temp directory per test.
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `sa-cli-prof-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  process.env.STELLAR_ALERTS_CONFIG_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.STELLAR_ALERTS_CONFIG_DIR;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  vi.resetModules();
});

async function getModule() {
  return import('./profileManager.js');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('profileManager — CRUD', () => {
  it('returns empty list when no profiles exist', async () => {
    const { listProfiles } = await getModule();
    expect(listProfiles()).toEqual([]);
  });

  it('creates a profile and returns it', async () => {
    const { createProfile, getProfile } = await getModule();
    const p = createProfile('dev', 'http://localhost:3001');
    expect(p.name).toBe('dev');
    expect(p.apiUrl).toBe('http://localhost:3001');
    expect(p.createdAt).toBeTruthy();

    const fetched = getProfile('dev');
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('dev');
  });

  it('auto-activates the first profile', async () => {
    const { createProfile, getActiveProfileName } = await getModule();
    createProfile('first', 'http://localhost:3001');
    expect(getActiveProfileName()).toBe('first');
  });

  it('does NOT auto-activate subsequent profiles', async () => {
    const { createProfile, getActiveProfileName } = await getModule();
    createProfile('first', 'http://localhost:3001');
    createProfile('second', 'http://localhost:4000');
    expect(getActiveProfileName()).toBe('first');
  });

  it('lists profiles sorted by name', async () => {
    const { createProfile, listProfiles } = await getModule();
    createProfile('zebra', 'http://z.example');
    createProfile('alpha', 'http://a.example');
    createProfile('mango', 'http://m.example');

    const names = listProfiles().map(p => p.name);
    expect(names).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('returns null for an unknown profile', async () => {
    const { getProfile } = await getModule();
    expect(getProfile('ghost')).toBeNull();
  });

  it('throws when creating a duplicate profile', async () => {
    const { createProfile } = await getModule();
    createProfile('dup', 'http://localhost:3001');
    expect(() => createProfile('dup', 'http://localhost:9999')).toThrow(/already exists/);
  });

  it('updates the apiUrl of an existing profile', async () => {
    const { createProfile, updateProfile, getProfile } = await getModule();
    createProfile('env', 'http://old.example');
    updateProfile('env', 'http://new.example');
    expect(getProfile('env')!.apiUrl).toBe('http://new.example');
  });

  it('throws on update of unknown profile', async () => {
    const { updateProfile } = await getModule();
    expect(() => updateProfile('ghost', 'http://x.example')).toThrow(/does not exist/);
  });

  it('deletes a profile', async () => {
    const { createProfile, deleteProfile, getProfile } = await getModule();
    createProfile('temp', 'http://localhost:3001');
    deleteProfile('temp');
    expect(getProfile('temp')).toBeNull();
  });

  it('throws when deleting an unknown profile', async () => {
    const { deleteProfile } = await getModule();
    expect(() => deleteProfile('ghost')).toThrow(/does not exist/);
  });
});

describe('profileManager — active profile', () => {
  it('returns null active profile when no profiles exist', async () => {
    const { getActiveProfile, getActiveProfileName } = await getModule();
    expect(getActiveProfile()).toBeNull();
    expect(getActiveProfileName()).toBeNull();
  });

  it('switches active profile with setActiveProfile', async () => {
    const { createProfile, setActiveProfile, getActiveProfileName } = await getModule();
    createProfile('a', 'http://a.example');
    createProfile('b', 'http://b.example');

    setActiveProfile('b');
    expect(getActiveProfileName()).toBe('b');

    setActiveProfile('a');
    expect(getActiveProfileName()).toBe('a');
  });

  it('throws when switching to a non-existent profile', async () => {
    const { setActiveProfile } = await getModule();
    expect(() => setActiveProfile('ghost')).toThrow(/does not exist/);
  });

  it('clears active profile when last profile is deleted', async () => {
    const { createProfile, deleteProfile, getActiveProfileName } = await getModule();
    createProfile('only', 'http://localhost:3001');
    deleteProfile('only');
    expect(getActiveProfileName()).toBeNull();
  });

  it('falls back to another profile when active profile is deleted', async () => {
    const { createProfile, setActiveProfile, deleteProfile, getActiveProfileName } = await getModule();
    createProfile('a', 'http://a.example');
    createProfile('b', 'http://b.example');
    setActiveProfile('b');
    deleteProfile('b');
    // Should fall back to 'a' (the remaining profile).
    expect(getActiveProfileName()).toBe('a');
  });
});

describe('profileManager — validation', () => {
  it('accepts valid profile names', async () => {
    const { validateProfileName } = await getModule();
    expect(() => validateProfileName('dev')).not.toThrow();
    expect(() => validateProfileName('prod-v2')).not.toThrow();
    expect(() => validateProfileName('my_env_123')).not.toThrow();
  });

  it('rejects profile names starting with a hyphen', async () => {
    const { validateProfileName } = await getModule();
    expect(() => validateProfileName('-bad')).toThrow(/Invalid profile name/);
  });

  it('rejects profile names with spaces', async () => {
    const { validateProfileName } = await getModule();
    expect(() => validateProfileName('my profile')).toThrow(/Invalid profile name/);
  });

  it('rejects empty profile names', async () => {
    const { validateProfileName } = await getModule();
    expect(() => validateProfileName('')).toThrow(/Invalid profile name/);
  });
});
