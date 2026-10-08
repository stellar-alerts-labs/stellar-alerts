import { registerSupervisorHeartbeat } from './supervisor';

// #423: watches SDEX (Stellar DEX) limit orders for watched accounts.
// Two independently-triggerable conditions, matching the issue's own
// "cancelled ... or become stale" framing as two separate checks rather
// than one combined rule:
//   1. Cancellation — a manage_sell_offer/manage_buy_offer operation that
//      sets amount to 0 against an existing (non-zero offerId) offer.
//   2. Inactivity — an open offer that hasn't been touched (no matching
//      operation against its offerId) for longer than a configured window.
//
// Deliberately out of scope: detecting staleness from market *price*
// divergence (the issue's other suggested trigger). That needs a live
// reference price for the asset pair, either Horizon's /order_book
// endpoint or an external price feed, polled continuously and compared
// against each open offer's price, a meaningfully larger integration than
// the operation-based and time-based checks here, which need no external
// market data at all. Flagging as a follow-up rather than guessing at a
// shape for it.

const POLL_INTERVAL_MS = 30_000;
/** How long an offer can sit untouched before it's flagged as stale.
 *  Default 3 days, expressed in seconds since offer age is tracked by
 *  wall-clock time (Horizon's created_at), not ledger sequence. */
const STALE_INACTIVITY_SECONDS = parseInt(
  process.env.SDEX_STALE_INACTIVITY_SECONDS || String(3 * 24 * 60 * 60),
  10,
);

export interface StellarOfferOperation {
  id: string;
  type: string; // 'manage_sell_offer' | 'manage_buy_offer' | 'create_passive_sell_offer'
  sourceAccount: string;
  offerId?: string; // '0' for a brand-new offer; non-zero references an existing one
  amount?: string; // '0' on an existing offerId means cancellation
  sellingAssetCode?: string;
  buyingAssetCode?: string;
  createdAt: Date | string;
}

export interface OpenSdexOffer {
  offerId: string;
  sellerAccount: string;
  sellingAssetCode: string;
  buyingAssetCode: string;
  amount: string;
  price: string;
  lastModifiedAt: Date | string;
}

export type SdexAlertType = 'CANCELLED' | 'STALE_INACTIVE';

export interface SdexOfferAlert {
  alertType: SdexAlertType;
  offerId: string;
  account: string;
  sellingAssetCode: string;
  buyingAssetCode: string;
  reason: string;
  inactiveSeconds?: number;
}

export type SdexOfferNotifier = (alert: SdexOfferAlert) => Promise<void> | void;

export const defaultSdexOfferNotifier: SdexOfferNotifier = (alert) => {
  console.log(
    `[SdexOfferWatcher] 🚨 ${alert.alertType} offer ${alert.offerId} (${alert.account}) ` +
      `${alert.sellingAssetCode}->${alert.buyingAssetCode} - ${alert.reason}`,
  );
};

/**
 * Inspects a manage-offer operation and returns a CANCELLED alert if it
 * zeroes out an existing offer's amount. A `create_passive_sell_offer` or a
 * manage-offer with offerId '0' is a *new* offer, not a cancellation, even
 * if its amount happens to be 0 (which Horizon rejects as invalid anyway,
 * but this still shouldn't misclassify it).
 */
export function evaluateOfferCancellation(op: StellarOfferOperation): SdexOfferAlert | null {
  if (op.type !== 'manage_sell_offer' && op.type !== 'manage_buy_offer') return null;
  if (!op.offerId || op.offerId === '0') return null;
  if (op.amount !== '0') return null;

  return {
    alertType: 'CANCELLED',
    offerId: op.offerId,
    account: op.sourceAccount,
    sellingAssetCode: op.sellingAssetCode ?? 'UNKNOWN',
    buyingAssetCode: op.buyingAssetCode ?? 'UNKNOWN',
    reason: 'Offer amount set to 0, cancelling the existing order.',
  };
}

/**
 * Flags a still-open offer that hasn't been modified (no manage-offer
 * operation seen against its offerId) for longer than
 * STALE_INACTIVITY_SECONDS.
 */
export function evaluateOfferInactivity(
  offer: OpenSdexOffer,
  now: Date = new Date(),
  thresholdSeconds: number = STALE_INACTIVITY_SECONDS,
): SdexOfferAlert | null {
  const lastModified =
    offer.lastModifiedAt instanceof Date ? offer.lastModifiedAt : new Date(offer.lastModifiedAt);
  const inactiveSeconds = Math.floor((now.getTime() - lastModified.getTime()) / 1000);

  if (inactiveSeconds < thresholdSeconds) return null;

  return {
    alertType: 'STALE_INACTIVE',
    offerId: offer.offerId,
    account: offer.sellerAccount,
    sellingAssetCode: offer.sellingAssetCode,
    buyingAssetCode: offer.buyingAssetCode,
    inactiveSeconds,
    reason: `Offer has been open and untouched for ${inactiveSeconds}s, at or beyond the ${thresholdSeconds}s inactivity threshold.`,
  };
}

/** Evaluates a batch of manage-offer operations for cancellations. */
export function detectCancellationsFromOperationBatch(
  ops: StellarOfferOperation[],
): SdexOfferAlert[] {
  const alerts: SdexOfferAlert[] = [];
  for (const op of ops) {
    const alert = evaluateOfferCancellation(op);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

/** Evaluates a set of currently-open offers for inactivity staleness. */
export function detectStaleOffers(
  offers: OpenSdexOffer[],
  now: Date = new Date(),
  thresholdSeconds: number = STALE_INACTIVITY_SECONDS,
): SdexOfferAlert[] {
  const alerts: SdexOfferAlert[] = [];
  for (const offer of offers) {
    const alert = evaluateOfferInactivity(offer, now, thresholdSeconds);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

export function getWatchedSdexAccounts(): string[] {
  const fromEnv = (process.env.SDEX_WATCHED_ACCOUNTS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return Array.from(new Set(fromEnv));
}

export async function runSdexOfferWatcher() {
  console.log('[SdexOfferWatcher] 🚀 Starting SDEX Order Cancellation & Stale Offer Watcher...');
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runSdexOfferWatcher();
}
