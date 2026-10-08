/**
 * Credential Store — OS-appropriate secure token storage for the CLI.
 *
 * Strategy (in preference order):
 *  1. macOS  → tries `security` keychain CLI (no native dep required)
 *  2. Linux  → tries `secret-tool` (libsecret) if available
 *  3. Fallback (all platforms, including Windows) → AES-256-GCM encrypted
 *     JSON file stored in the user's config directory with 0600 permissions.
 *
 * The fallback file lives at:
 *   ~/<configDir>/stellar-alerts-cli/credentials.enc
 *
 * Tokens are stored per-service (keyed by profile name).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SERVICE_NAME = 'stellar-alerts-cli';
const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

// ---------------------------------------------------------------------------
// Helpers — file-based encrypted fallback
// ---------------------------------------------------------------------------

/**
 * Returns the directory where the encrypted credentials file lives.
 * Respects $STELLAR_ALERTS_CONFIG_DIR for testability.
 */
export function getCredentialDir(): string {
  const base =
    process.env.STELLAR_ALERTS_CONFIG_DIR ||
    join(homedir(), '.config', SERVICE_NAME);
  return base;
}

function getCredentialFilePath(): string {
  return join(getCredentialDir(), 'credentials.enc');
}

/**
 * Derives a 32-byte AES key from a machine-specific secret using scrypt.
 * The "secret" is a combination of the home directory path (stable, unique
 * enough for local protection) and a fixed pepper.  This is not a
 * cryptographic secret-key store replacement — it prevents trivial plaintext
 * exposure on disk.
 */
function deriveKey(salt: Buffer): Buffer {
  const secret = `stellar-alerts-cli:${homedir()}:local-credential-store`;
  return scryptSync(secret, salt, KEY_LEN);
}

interface EncryptedStore {
  [profile: string]: string; // profile name → encrypted token blob (hex)
}

/** Reads and decrypts the on-disk credential store. */
function readStore(): EncryptedStore {
  const filePath = getCredentialFilePath();
  if (!existsSync(filePath)) return {};

  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    const buf = Buffer.from(raw, 'hex');

    const salt = buf.subarray(0, SALT_LEN);
    const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);

    const key = deriveKey(salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plain.toString('utf-8'));
  } catch {
    // Corrupted or unreadable — start fresh.
    return {};
  }
}

/** Encrypts and writes the credential store to disk with restricted permissions. */
function writeStore(store: EncryptedStore): void {
  const dir = getCredentialDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plain = Buffer.from(JSON.stringify(store), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  const blob = Buffer.concat([salt, iv, tag, ciphertext]);
  const filePath = getCredentialFilePath();
  writeFileSync(filePath, blob.toString('hex'), { encoding: 'utf-8', mode: 0o600 });

  // Enforce permissions even on subsequent writes.
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Non-fatal on platforms that don't support chmod (e.g. some Windows FS).
  }
}

// ---------------------------------------------------------------------------
// Platform-specific backends (optional, no native deps)
// ---------------------------------------------------------------------------

/** macOS: use the system `security` CLI to access the keychain. */
function macosGet(account: string): string | null {
  try {
    const result = execSync(
      `security find-generic-password -s "${SERVICE_NAME}" -a "${account}" -w 2>/dev/null`,
      { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return result.toString('utf-8').trim() || null;
  } catch {
    return null;
  }
}

function macosSet(account: string, token: string): boolean {
  try {
    // Delete any existing entry first to avoid duplicates.
    execSync(
      `security delete-generic-password -s "${SERVICE_NAME}" -a "${account}" 2>/dev/null || true`,
      { timeout: 3000, stdio: 'ignore' }
    );
    execSync(
      `security add-generic-password -s "${SERVICE_NAME}" -a "${account}" -w "${token}"`,
      { timeout: 3000, stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

function macosDelete(account: string): boolean {
  try {
    execSync(
      `security delete-generic-password -s "${SERVICE_NAME}" -a "${account}" 2>/dev/null || true`,
      { timeout: 3000, stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

/** Linux: use `secret-tool` (libsecret) if installed. */
function linuxGet(account: string): string | null {
  try {
    const result = execSync(
      `secret-tool lookup service "${SERVICE_NAME}" account "${account}" 2>/dev/null`,
      { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return result.toString('utf-8').trim() || null;
  } catch {
    return null;
  }
}

function linuxSet(account: string, token: string): boolean {
  try {
    execSync(
      `printf '%s' "${token}" | secret-tool store --label="${SERVICE_NAME}:${account}" service "${SERVICE_NAME}" account "${account}" 2>/dev/null`,
      { timeout: 3000, stdio: 'ignore', shell: '/bin/sh' }
    );
    return true;
  } catch {
    return false;
  }
}

function linuxDelete(account: string): boolean {
  try {
    execSync(
      `secret-tool clear service "${SERVICE_NAME}" account "${account}" 2>/dev/null || true`,
      { timeout: 3000, stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieves a stored token for the given profile name.
 * Returns `null` if no token is stored.
 */
export function getToken(profile: string): string | null {
  const os = platform();

  if (os === 'darwin') {
    const val = macosGet(profile);
    if (val !== null) return val;
    // Fall through to file store if keychain lookup fails.
  } else if (os === 'linux') {
    const val = linuxGet(profile);
    if (val !== null) return val;
    // Fall through to file store.
  }

  // Windows or fallback
  const store = readStore();
  return store[profile] ?? null;
}

/**
 * Persists a token for the given profile name.
 */
export function setToken(profile: string, token: string): void {
  const os = platform();

  if (os === 'darwin') {
    if (macosSet(profile, token)) return;
  } else if (os === 'linux') {
    if (linuxSet(profile, token)) return;
  }

  // Windows or fallback
  const store = readStore();
  store[profile] = token;
  writeStore(store);
}

/**
 * Deletes a stored token for the given profile.
 * No-op if the profile does not exist.
 */
export function deleteToken(profile: string): void {
  const os = platform();

  if (os === 'darwin') {
    macosDelete(profile);
  } else if (os === 'linux') {
    linuxDelete(profile);
  }

  // Always clean up the file store too (handles migration case).
  const store = readStore();
  if (profile in store) {
    delete store[profile];
    writeStore(store);
  }
}

/**
 * Returns the redacted form of a token for safe display in diagnostics.
 * e.g. "eyJhbG...xyz"
 */
export function redactToken(token: string): string {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 6)}...${token.slice(-3)}`;
}
