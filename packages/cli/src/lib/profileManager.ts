/**
 * Profile Manager — named profile CRUD and active-profile tracking.
 *
 * A "profile" is a named set of CLI settings (API URL + stored token).
 * Profiles are persisted as a plain JSON file:
 *   ~/<configDir>/stellar-alerts-cli/profiles.json
 *
 * Token values are NOT stored in this file; they are read from the
 * credential store (credentialStore.ts). Only the profile metadata
 * (name, apiUrl, createdAt) lives here, plus a pointer to the active
 * profile name.
 *
 * Precedence when resolving credentials (see auth.ts):
 *   1. --token CLI flag  (highest)
 *   2. Active profile's stored token
 *   3. STELLAR_ALERTS_API_KEY env var  (lowest)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCredentialDir } from './credentialStore.js';
import { deleteToken } from './credentialStore.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Profile {
  /** Unique name for this profile (alphanumeric + hyphens). */
  name: string;
  /** API base URL for this profile. */
  apiUrl: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

interface ProfileStore {
  activeProfile: string | null;
  profiles: Record<string, Profile>;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function getProfileFilePath(): string {
  return join(getCredentialDir(), 'profiles.json');
}

function readProfileStore(): ProfileStore {
  const filePath = getProfileFilePath();
  if (!existsSync(filePath)) {
    return { activeProfile: null, profiles: {} };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as ProfileStore;
    // Defensive defaults in case the file is partially written.
    return {
      activeProfile: parsed.activeProfile ?? null,
      profiles: parsed.profiles ?? {},
    };
  } catch {
    return { activeProfile: null, profiles: {} };
  }
}

function writeProfileStore(store: ProfileStore): void {
  const dir = getCredentialDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(getProfileFilePath(), JSON.stringify(store, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

/**
 * Validates a profile name. Throws a descriptive error on failure.
 */
export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". ` +
        'Profile names must start with a letter or digit and contain only ' +
        'letters, digits, hyphens, or underscores (max 63 chars).'
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lists all profiles. Returns an empty array if none exist.
 */
export function listProfiles(): Profile[] {
  const store = readProfileStore();
  return Object.values(store.profiles).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

/**
 * Returns a profile by name, or `null` if not found.
 */
export function getProfile(name: string): Profile | null {
  const store = readProfileStore();
  return store.profiles[name] ?? null;
}

/**
 * Creates a new profile. Throws if the name is already taken.
 *
 * @param name    Profile name (validated).
 * @param apiUrl  API base URL for this profile.
 */
export function createProfile(name: string, apiUrl: string): Profile {
  validateProfileName(name);

  const store = readProfileStore();
  if (store.profiles[name]) {
    throw new Error(
      `Profile "${name}" already exists. ` +
        'Use `profile use` to switch to it or `profile edit` to update it.'
    );
  }

  const profile: Profile = {
    name,
    apiUrl,
    createdAt: new Date().toISOString(),
  };
  store.profiles[name] = profile;

  // Auto-activate if this is the first profile.
  if (store.activeProfile === null) {
    store.activeProfile = name;
  }

  writeProfileStore(store);
  return profile;
}

/**
 * Updates the apiUrl of an existing profile.
 */
export function updateProfile(name: string, apiUrl: string): Profile {
  const store = readProfileStore();
  const existing = store.profiles[name];
  if (!existing) {
    throw new Error(`Profile "${name}" does not exist.`);
  }
  existing.apiUrl = apiUrl;
  writeProfileStore(store);
  return existing;
}

/**
 * Deletes a profile and its stored token.
 * If the deleted profile was active, the active profile is cleared.
 */
export function deleteProfile(name: string): void {
  const store = readProfileStore();
  if (!store.profiles[name]) {
    throw new Error(`Profile "${name}" does not exist.`);
  }

  // Remove stored token from credential store.
  deleteToken(name);

  delete store.profiles[name];

  if (store.activeProfile === name) {
    // Fall back to another profile if one exists.
    const remaining = Object.keys(store.profiles);
    store.activeProfile = remaining.length > 0 ? remaining[0] : null;
  }

  writeProfileStore(store);
}

/**
 * Sets the active (default) profile.
 */
export function setActiveProfile(name: string): void {
  const store = readProfileStore();
  if (!store.profiles[name]) {
    throw new Error(`Profile "${name}" does not exist.`);
  }
  store.activeProfile = name;
  writeProfileStore(store);
}

/**
 * Returns the currently active profile, or `null` if none is set.
 */
export function getActiveProfile(): Profile | null {
  const store = readProfileStore();
  if (!store.activeProfile) return null;
  return store.profiles[store.activeProfile] ?? null;
}

/**
 * Returns the name of the active profile, or `null`.
 */
export function getActiveProfileName(): string | null {
  return readProfileStore().activeProfile;
}
