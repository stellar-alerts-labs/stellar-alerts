/**
 * Typed factory and invalid-fixture helpers for the User domain model.
 *
 * Usage:
 *   import { makeUser, invalidUserFixtures } from '@/tests/factories';
 *
 *   vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser());
 *   vi.mocked(prisma.user.upsert).mockResolvedValue(makeUser({ email: 'bob@example.com' }));
 */

/** Minimal shape of a Prisma User row as returned by the client. */
export interface UserRecord {
  id: string;
  email: string;
  mfaSecret: string | null;
  mfaEnabled: boolean;
  createdAt: Date;
}

let _userCounter = 0;

/**
 * Build a domain-valid User record, merging any overrides you supply.
 * Every call without an explicit `id` produces a unique, deterministic id.
 */
export function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  const n = ++_userCounter;
  return {
    id: `user-${n}`,
    email: `user-${n}@stellar-alerts.test`,
    mfaSecret: null,
    mfaEnabled: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Reset the auto-increment counter — call in beforeEach if ordering matters. */
export function resetUserCounter(): void {
  _userCounter = 0;
}

/**
 * Invalid User fixtures for negative / validation tests.
 * Each entry is intentionally malformed in one specific way.
 */
export const invalidUserFixtures = {
  /** Missing required email field. */
  missingEmail: { id: 'user-bad-1', mfaSecret: null, mfaEnabled: false, createdAt: new Date() } as Partial<UserRecord>,

  /** Empty string email — fails domain validation. */
  emptyEmail: makeUser({ email: '' }),

  /** Email without a domain part. */
  malformedEmail: makeUser({ email: 'not-an-email' }),

  /** MFA enabled but no secret stored — inconsistent state. */
  mfaEnabledWithoutSecret: makeUser({ mfaEnabled: true, mfaSecret: null }),
} as const;
