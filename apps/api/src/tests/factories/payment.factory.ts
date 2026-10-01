/**
 * Typed factory and invalid-fixture helpers for the Payment domain model.
 *
 * Usage:
 *   import { makePayment, invalidPaymentFixtures } from '@/tests/factories';
 *
 *   (prisma.payment.findMany as vi.Mock).mockResolvedValue([makePayment(), makePayment()]);
 *   vi.mocked(prisma.payment.create).mockResolvedValue(makePayment({ asset: 'USDC' }));
 */

/** Minimal shape of a Prisma Payment row as returned by the client. */
export interface PaymentRecord {
  id: string;
  walletId: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  asset: string;
  assetIssuer: string | null;
  memo: string | null;
  receivedAt: Date;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Known valid Stellar addresses reused across payment mocks.
// ---------------------------------------------------------------------------
const SENDER_ADDRESS = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSFMG4BVI';

let _paymentCounter = 0;

/**
 * Build a domain-valid Payment record, merging any overrides you supply.
 * `txHash` is unique per call so mock stores don't collide on the UNIQUE constraint.
 */
export function makePayment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  const n = ++_paymentCounter;
  // Pad to 64 hex chars — realistic tx hash length.
  const txHash = `tx${'0'.repeat(61)}${String(n).padStart(3, '0')}`;
  return {
    id: `payment-${n}`,
    walletId: `wallet-1`,
    txHash,
    fromAddress: SENDER_ADDRESS,
    amount: '10.0000000',
    asset: 'XLM',
    assetIssuer: null,
    memo: null,
    receivedAt: new Date('2026-09-01T12:00:00.000Z'),
    createdAt: new Date('2026-09-01T12:00:01.000Z'),
    ...overrides,
  };
}

/**
 * Build a list of `count` payments, each with a unique txHash and incrementing
 * receivedAt so ordering tests remain deterministic.
 */
export function makePayments(count: number, overrides: Partial<PaymentRecord> = {}): PaymentRecord[] {
  return Array.from({ length: count }, (_, i) =>
    makePayment({
      receivedAt: new Date(new Date('2026-09-01T12:00:00.000Z').getTime() + i * 60_000),
      ...overrides,
    }),
  );
}

/** Reset the auto-increment counter — call in beforeEach if ordering matters. */
export function resetPaymentCounter(): void {
  _paymentCounter = 0;
}

/**
 * Invalid Payment fixtures for negative / validation tests.
 */
export const invalidPaymentFixtures = {
  /** Negative amount — violates domain invariant. */
  negativeAmount: makePayment({ amount: '-1' }),

  /** Zero amount — economically invalid on Stellar. */
  zeroAmount: makePayment({ amount: '0' }),

  /** Empty txHash — violates the UNIQUE NOT NULL constraint. */
  emptyTxHash: makePayment({ txHash: '' }),

  /** fromAddress is blank — missing required sender. */
  blankFromAddress: makePayment({ fromAddress: '' }),

  /** Unknown asset code — 13 chars, exceeds Stellar 12-char max. */
  oversizedAssetCode: makePayment({ asset: 'TOOLONGASSETX' }),

  /** receivedAt is in the future — clock skew / tampered record. */
  futureReceivedAt: makePayment({ receivedAt: new Date('2099-01-01T00:00:00.000Z') }),

  /** Asset issuer present for native XLM — logically inconsistent. */
  nativeWithIssuer: makePayment({
    asset: 'XLM',
    assetIssuer: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSFMG4BVI',
  }),
} as const;
