/**
 * Unit tests for typed test factories and invalid fixtures (issue #328).
 *
 * These tests are intentionally fast and self-contained — no mocks, no I/O.
 * They verify that:
 *  1. Factories produce unique, domain-valid records on every call.
 *  2. Overrides are merged correctly.
 *  3. Invalid fixtures carry the expected broken state.
 *  4. Reset helpers restore counter state.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  makeUser,
  resetUserCounter,
  invalidUserFixtures,
  makeWallet,
  makeWalletWithCursor,
  makeIngestionCursor,
  resetWalletCounter,
  invalidWalletFixtures,
  STELLAR_PUBLIC_KEYS,
  makePayment,
  makePayments,
  resetPaymentCounter,
  invalidPaymentFixtures,
  makeAlertJob,
  makeAlertJobs,
  resetJobCounter,
  invalidJobFixtures,
} from './index';

// ---------------------------------------------------------------------------
// Reset all counters before each test so IDs are deterministic.
// ---------------------------------------------------------------------------
beforeEach(() => {
  resetUserCounter();
  resetWalletCounter();
  resetPaymentCounter();
  resetJobCounter();
});

// ---------------------------------------------------------------------------
// User factory
// ---------------------------------------------------------------------------
describe('makeUser', () => {
  it('produces a unique id on every call', () => {
    const a = makeUser();
    const b = makeUser();
    expect(a.id).not.toBe(b.id);
  });

  it('returns a domain-valid email by default', () => {
    const user = makeUser();
    expect(user.email).toMatch(/@stellar-alerts\.test$/);
  });

  it('merges overrides onto the defaults', () => {
    const user = makeUser({ email: 'alice@example.com', mfaEnabled: true });
    expect(user.email).toBe('alice@example.com');
    expect(user.mfaEnabled).toBe(true);
    // Fields not overridden keep their defaults
    expect(user.mfaSecret).toBeNull();
  });

  it('resets the counter so the first call after reset returns id user-1', () => {
    makeUser();
    makeUser();
    resetUserCounter();
    expect(makeUser().id).toBe('user-1');
  });
});

describe('invalidUserFixtures', () => {
  it('emptyEmail has an empty email string', () => {
    expect(invalidUserFixtures.emptyEmail.email).toBe('');
  });

  it('malformedEmail is not a valid email format', () => {
    expect(invalidUserFixtures.malformedEmail.email).not.toContain('@');
  });

  it('mfaEnabledWithoutSecret has mfaEnabled=true but null secret', () => {
    const f = invalidUserFixtures.mfaEnabledWithoutSecret;
    expect(f.mfaEnabled).toBe(true);
    expect(f.mfaSecret).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wallet factory
// ---------------------------------------------------------------------------
describe('makeWallet', () => {
  it('produces a unique id on every call', () => {
    const a = makeWallet();
    const b = makeWallet();
    expect(a.id).not.toBe(b.id);
  });

  it('cycles through known valid Stellar public keys', () => {
    const keys = Array.from({ length: STELLAR_PUBLIC_KEYS.length + 1 }, () => makeWallet().publicKey);
    // Every key must be one of the known-valid list
    keys.forEach(k => expect(STELLAR_PUBLIC_KEYS).toContain(k));
  });

  it('merges overrides correctly', () => {
    const wallet = makeWallet({ label: 'Treasury', userId: 'u-override' });
    expect(wallet.label).toBe('Treasury');
    expect(wallet.userId).toBe('u-override');
  });
});

describe('makeWalletWithCursor', () => {
  it('includes a non-null cursor with status active by default', () => {
    const w = makeWalletWithCursor();
    expect(w.cursor).not.toBeNull();
    expect(w.cursor?.status).toBe('active');
  });

  it('forwards cursor overrides', () => {
    const w = makeWalletWithCursor({}, { status: 'gap_detected', consecutiveFailures: 5 });
    expect(w.cursor?.status).toBe('gap_detected');
    expect(w.cursor?.consecutiveFailures).toBe(5);
  });
});

describe('makeIngestionCursor', () => {
  it('defaults to active status with zero failures', () => {
    const cursor = makeIngestionCursor();
    expect(cursor.status).toBe('active');
    expect(cursor.consecutiveFailures).toBe(0);
    expect(cursor.lastError).toBeNull();
  });
});

describe('invalidWalletFixtures', () => {
  it('emptyPublicKey has an empty publicKey', () => {
    expect(invalidWalletFixtures.emptyPublicKey.publicKey).toBe('');
  });

  it('shortPublicKey is shorter than a valid Stellar key (56 chars)', () => {
    expect(invalidWalletFixtures.shortPublicKey.publicKey.length).toBeLessThan(56);
  });

  it('wrongChecksumKey does not start with G', () => {
    expect(invalidWalletFixtures.wrongChecksumKey.publicKey[0]).not.toBe('G');
  });

  it('gapDetectedCursor has gap_detected status and non-zero failures', () => {
    const c = invalidWalletFixtures.gapDetectedCursor;
    expect(c.status).toBe('gap_detected');
    expect(c.consecutiveFailures).toBeGreaterThan(0);
    expect(c.lastError).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Payment factory
// ---------------------------------------------------------------------------
describe('makePayment', () => {
  it('produces a unique txHash on every call', () => {
    const a = makePayment();
    const b = makePayment();
    expect(a.txHash).not.toBe(b.txHash);
  });

  it('amount is a string with correct decimal precision', () => {
    const p = makePayment();
    expect(typeof p.amount).toBe('string');
    expect(p.amount).toBe('10.0000000');
  });

  it('merges overrides correctly', () => {
    const p = makePayment({ asset: 'USDC', memo: 'invoice-42' });
    expect(p.asset).toBe('USDC');
    expect(p.memo).toBe('invoice-42');
  });

  it('makePayments builds the requested count with unique txHashes', () => {
    const list = makePayments(5);
    expect(list).toHaveLength(5);
    const hashes = new Set(list.map(p => p.txHash));
    expect(hashes.size).toBe(5);
  });

  it('makePayments stamps incrementing receivedAt times', () => {
    const list = makePayments(3);
    expect(list[1].receivedAt.getTime()).toBeGreaterThan(list[0].receivedAt.getTime());
    expect(list[2].receivedAt.getTime()).toBeGreaterThan(list[1].receivedAt.getTime());
  });
});

describe('invalidPaymentFixtures', () => {
  it('negativeAmount is less than zero', () => {
    expect(Number(invalidPaymentFixtures.negativeAmount.amount)).toBeLessThan(0);
  });

  it('zeroAmount equals zero', () => {
    expect(Number(invalidPaymentFixtures.zeroAmount.amount)).toBe(0);
  });

  it('emptyTxHash has an empty txHash', () => {
    expect(invalidPaymentFixtures.emptyTxHash.txHash).toBe('');
  });

  it('nativeWithIssuer has XLM asset with a non-null issuer', () => {
    const f = invalidPaymentFixtures.nativeWithIssuer;
    expect(f.asset).toBe('XLM');
    expect(f.assetIssuer).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AlertJobData factory
// ---------------------------------------------------------------------------
describe('makeAlertJob', () => {
  it('produces a unique paymentId and txHash on every call', () => {
    const a = makeAlertJob();
    const b = makeAlertJob();
    expect(a.paymentId).not.toBe(b.paymentId);
    expect(a.txHash).not.toBe(b.txHash);
  });

  it('conforms to the AlertJobData interface shape', () => {
    const job = makeAlertJob();
    expect(typeof job.paymentId).toBe('string');
    expect(typeof job.txHash).toBe('string');
    expect(typeof job.walletId).toBe('string');
    expect(typeof job.amount).toBe('string');
    expect(typeof job.asset).toBe('string');
    expect(typeof job.fromAddress).toBe('string');
    expect(typeof job.receivedAt).toBe('string');
  });

  it('merges overrides correctly', () => {
    const job = makeAlertJob({ asset: 'USDC', amount: '500.0000000' });
    expect(job.asset).toBe('USDC');
    expect(job.amount).toBe('500.0000000');
  });

  it('makeAlertJobs builds the requested count with unique ids', () => {
    const jobs = makeAlertJobs(4);
    expect(jobs).toHaveLength(4);
    const ids = new Set(jobs.map(j => j.paymentId));
    expect(ids.size).toBe(4);
  });
});

describe('invalidJobFixtures', () => {
  it('missingPaymentId has an empty paymentId', () => {
    expect(invalidJobFixtures.missingPaymentId.paymentId).toBe('');
  });

  it('missingTxHash has an empty txHash', () => {
    expect(invalidJobFixtures.missingTxHash.txHash).toBe('');
  });

  it('zeroAmount amount string is "0"', () => {
    expect(invalidJobFixtures.zeroAmount.amount).toBe('0');
  });

  it('invalidReceivedAt is not a parseable ISO date', () => {
    expect(isNaN(Date.parse(invalidJobFixtures.invalidReceivedAt.receivedAt))).toBe(true);
  });

  it('nativeWithIssuer has XLM with a non-null assetIssuer', () => {
    const f = invalidJobFixtures.nativeWithIssuer;
    expect(f.asset).toBe('XLM');
    expect(f.assetIssuer).not.toBeNull();
  });
});
