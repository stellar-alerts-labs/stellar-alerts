/**
 * Typed factory and invalid-fixture helpers for BullMQ AlertJobData.
 *
 * Usage:
 *   import { makeAlertJob, invalidJobFixtures } from '@/tests/factories';
 *
 *   vi.mocked(enqueuePaymentAlert).mockResolvedValue(undefined);
 *   const job = makeAlertJob({ asset: 'USDC', amount: '50.0000000' });
 */

import type { AlertJobData } from '../../lib/queue';

// Re-export so consumers can reference the type without touching lib/queue directly.
export type { AlertJobData };

const SENDER_ADDRESS = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSFMG4BVI';

let _jobCounter = 0;

/**
 * Build a domain-valid AlertJobData object, merging any overrides you supply.
 * Every call without explicit `paymentId`/`txHash` produces unique identifiers.
 */
export function makeAlertJob(overrides: Partial<AlertJobData> = {}): AlertJobData {
  const n = ++_jobCounter;
  const txHash = `tx${'0'.repeat(61)}${String(n).padStart(3, '0')}`;
  return {
    paymentId: `payment-${n}`,
    txHash,
    walletId: `wallet-1`,
    amount: '10.0000000',
    asset: 'XLM',
    assetIssuer: null,
    fromAddress: SENDER_ADDRESS,
    receivedAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Build a list of `count` alert jobs, each with a unique paymentId/txHash.
 */
export function makeAlertJobs(count: number, overrides: Partial<AlertJobData> = {}): AlertJobData[] {
  return Array.from({ length: count }, () => makeAlertJob(overrides));
}

/** Reset the auto-increment counter — call in beforeEach if ordering matters. */
export function resetJobCounter(): void {
  _jobCounter = 0;
}

/**
 * Invalid AlertJobData fixtures for negative / edge-case tests.
 */
export const invalidJobFixtures = {
  /** Empty paymentId — no way to correlate back to a Payment row. */
  missingPaymentId: makeAlertJob({ paymentId: '' }),

  /** Empty txHash — can't look up or deduplicate the transaction. */
  missingTxHash: makeAlertJob({ txHash: '' }),

  /** Empty walletId — job can't be routed to a wallet. */
  missingWalletId: makeAlertJob({ walletId: '' }),

  /** Zero amount string — economically invalid. */
  zeroAmount: makeAlertJob({ amount: '0' }),

  /** Negative amount string. */
  negativeAmount: makeAlertJob({ amount: '-5.0000000' }),

  /** receivedAt is not ISO-8601 — will break any Date parsing downstream. */
  invalidReceivedAt: makeAlertJob({ receivedAt: 'not-a-date' }),

  /** Asset issuer present alongside native XLM — logically inconsistent. */
  nativeWithIssuer: makeAlertJob({
    asset: 'XLM',
    assetIssuer: SENDER_ADDRESS,
  }),

  /** Large payload — helps verify serialisation size limits on the queue. */
  oversizedMemo: makeAlertJob({ amount: '9'.repeat(30) }),
} as const;
