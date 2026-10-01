/**
 * Typed factory and invalid-fixture helpers for the Wallet domain model.
 *
 * Usage:
 *   import { makeWallet, invalidWalletFixtures } from '@/tests/factories';
 *
 *   vi.mocked(prisma.wallet.create).mockResolvedValue(makeWallet());
 *   vi.mocked(prisma.wallet.findUnique).mockResolvedValue(makeWallet({ userId: 'u-99' }));
 */

/** Minimal shape of a Prisma Wallet row as returned by the client. */
export interface WalletRecord {
  id: string;
  userId: string;
  publicKey: string;
  label: string | null;
  createdAt: Date;
}

/**
 * Wallet row with its optional IngestionCursor relation included.
 * Mirrors the shape returned by `prisma.wallet.findUnique({ include: { cursor: true } })`.
 */
export interface WalletWithCursor extends WalletRecord {
  cursor: IngestionCursorRecord | null;
}

/** Minimal shape of a Prisma IngestionCursor row. */
export interface IngestionCursorRecord {
  id: string;
  walletId: string;
  pagingToken: string;
  lastSyncedAt: Date;
  createdAt: Date;
  status: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: Date | null;
  gapDetectedAt: Date | null;
  lastGapLedgerDelta: number | null;
}

// ---------------------------------------------------------------------------
// Known valid Stellar Ed25519 public keys used as test fixtures.
// These are real-format keys so any downstream sdk validation stays green.
// ---------------------------------------------------------------------------
export const STELLAR_PUBLIC_KEYS = [
  'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
  'GDS6OIGNYZTBIQPZF5XUWZ5JTEBFTAQYYEIWPI4IMVS67DGE6I7D6KYA',
  'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSFMG4BVI',
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
] as const;

let _walletCounter = 0;

/**
 * Build a domain-valid Wallet record, merging any overrides you supply.
 * The `publicKey` cycles through known valid Stellar addresses so tests
 * that exercise sdk validation don't need to supply them manually.
 */
export function makeWallet(overrides: Partial<WalletRecord> = {}): WalletRecord {
  const n = ++_walletCounter;
  return {
    id: `wallet-${n}`,
    userId: `user-${n}`,
    publicKey: STELLAR_PUBLIC_KEYS[(n - 1) % STELLAR_PUBLIC_KEYS.length],
    label: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Build a Wallet that includes a healthy IngestionCursor relation. */
export function makeWalletWithCursor(
  walletOverrides: Partial<WalletRecord> = {},
  cursorOverrides: Partial<IngestionCursorRecord> = {},
): WalletWithCursor {
  const wallet = makeWallet(walletOverrides);
  return {
    ...wallet,
    cursor: makeIngestionCursor({ walletId: wallet.id, ...cursorOverrides }),
  };
}

/** Build a domain-valid IngestionCursor record. */
export function makeIngestionCursor(
  overrides: Partial<IngestionCursorRecord> = {},
): IngestionCursorRecord {
  const n = _walletCounter || 1;
  return {
    id: `cursor-${n}`,
    walletId: `wallet-${n}`,
    pagingToken: String(n * 1000),
    lastSyncedAt: new Date('2026-09-23T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    status: 'active',
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: new Date('2026-09-23T00:00:00.000Z'),
    gapDetectedAt: null,
    lastGapLedgerDelta: null,
    ...overrides,
  };
}

/** Reset the auto-increment counter — call in beforeEach if ordering matters. */
export function resetWalletCounter(): void {
  _walletCounter = 0;
}

/**
 * Invalid Wallet fixtures for negative / validation tests.
 */
export const invalidWalletFixtures = {
  /** Public key is an empty string — fails Stellar validation. */
  emptyPublicKey: makeWallet({ publicKey: '' }),

  /** Public key has the wrong length. */
  shortPublicKey: makeWallet({ publicKey: 'GBADKEY' }),

  /** Public key starts with wrong character (Stellar keys start with G). */
  wrongChecksumKey: makeWallet({ publicKey: 'XBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72' }),

  /** Label exceeds any reasonable UI truncation limit. */
  oversizedLabel: makeWallet({ label: 'A'.repeat(300) }),

  /** Missing userId — orphaned wallet, violates FK. */
  missingUserId: { id: 'wallet-bad-1', publicKey: STELLAR_PUBLIC_KEYS[0], label: null, createdAt: new Date() } as Partial<WalletRecord>,

  /** Cursor with gap_detected status — for ingestion health tests. */
  gapDetectedCursor: makeIngestionCursor({
    status: 'gap_detected',
    consecutiveFailures: 3,
    lastError: 'All Horizon nodes unreachable',
    gapDetectedAt: new Date('2026-09-23T00:00:00.000Z'),
    lastGapLedgerDelta: 42,
  }),
} as const;
