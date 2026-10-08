import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Isolate file-based store in a temp directory for every test.
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `sa-cli-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  process.env.STELLAR_ALERTS_CONFIG_DIR = tempDir;
  // Reset module cache so the module picks up the new env var.
  vi.resetModules();
});

afterEach(() => {
  delete process.env.STELLAR_ALERTS_CONFIG_DIR;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Helpers — re-import after module reset
// ---------------------------------------------------------------------------
async function getModule() {
  return import('./credentialStore.js');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('credentialStore — file-based fallback', () => {
  it('returns null for an unknown profile', async () => {
    const { getToken } = await getModule();
    expect(getToken('nonexistent')).toBeNull();
  });

  it('stores and retrieves a token', async () => {
    const { setToken, getToken } = await getModule();
    setToken('default', 'my-secret-token');
    expect(getToken('default')).toBe('my-secret-token');
  });

  it('persists across separate module loads (same config dir)', async () => {
    const { setToken } = await getModule();
    setToken('prod', 'persist-me');

    // Simulate a second invocation by re-importing.
    vi.resetModules();
    const { getToken } = await getModule();
    expect(getToken('prod')).toBe('persist-me');
  });

  it('stores multiple profiles independently', async () => {
    const { setToken, getToken } = await getModule();
    setToken('dev', 'dev-token');
    setToken('prod', 'prod-token');

    expect(getToken('dev')).toBe('dev-token');
    expect(getToken('prod')).toBe('prod-token');
  });

  it('overwrites an existing token', async () => {
    const { setToken, getToken } = await getModule();
    setToken('alpha', 'old-token');
    setToken('alpha', 'new-token');
    expect(getToken('alpha')).toBe('new-token');
  });

  it('deletes a token', async () => {
    const { setToken, deleteToken, getToken } = await getModule();
    setToken('temp', 'to-delete');
    deleteToken('temp');
    expect(getToken('temp')).toBeNull();
  });

  it('delete is idempotent for unknown profiles', async () => {
    const { deleteToken } = await getModule();
    // Should not throw.
    expect(() => deleteToken('ghost')).not.toThrow();
  });

  it('stores the encrypted file with restricted permissions on supported platforms', async () => {
    const { setToken, getCredentialDir } = await getModule();
    setToken('perm-test', 'some-token');

    const { statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const file = join(getCredentialDir(), 'credentials.enc');
    const stat = statSync(file);

    // On Windows, mode checks are not meaningful — skip.
    if (process.platform !== 'win32') {
      // 0o600 = owner read/write only
      expect(stat.mode & 0o777).toBe(0o600);
    } else {
      expect(existsSync(file)).toBe(true);
    }
  });
});

describe('credentialStore — redactToken', () => {
  it('redacts short tokens fully', async () => {
    const { redactToken } = await getModule();
    expect(redactToken('abc')).toBe('***');
  });

  it('shows prefix and suffix for longer tokens', async () => {
    const { redactToken } = await getModule();
    const result = redactToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).toMatch(/^eyJhbG\.\.\..{3}$/);
  });

  it('handles exactly 8-char token', async () => {
    const { redactToken } = await getModule();
    // <= 8 chars → '***'
    expect(redactToken('12345678')).toBe('***');
  });

  it('handles 9-char token (above threshold)', async () => {
    const { redactToken } = await getModule();
    const result = redactToken('123456789');
    expect(result).toBe('123456...789');
  });
});
