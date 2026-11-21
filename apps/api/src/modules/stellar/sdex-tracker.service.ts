/**
 * SDEX offer lifecycle, whale wall and spoofing tracker (#976).
 *
 * Follows each limit offer of the monitored accounts through creation, update, partial fill, full
 * execution and cancellation, and flags whale offers that are placed and cancelled within a few
 * ledgers without trading (a spoofing pattern).
 *
 * It is pure logic over parsed events and an injected XLM valuer, so it needs no Horizon or
 * database. Feeding it from the watcher worker, and persisting offer state, are separate steps.
 *
 * Conventions:
 *  - An offer operation with `amount` `0` cancels the offer. An operation whose `offerId` is
 *    already tracked updates it; any other offer id creates it. The caller supplies the offer id
 *    that results from the operation (Horizon reports it in the operation effects).
 *  - A trade event is a fill of the offer's owner's offer. The offer is fully executed when the
 *    remaining amount reaches zero.
 */

import { formatXlm, parseStroops, STROOPS_PER_XLM } from './amounts';

export type OfferOperationType = 'manage_sell_offer' | 'manage_buy_offer' | 'create_passive_sell_offer';

export interface OfferOperationEvent {
  kind: 'offer_operation';
  /** Unique per operation; used to ignore replays. */
  operationId: string;
  type: OfferOperationType;
  accountId: string;
  /** The id of the offer the operation created, changed or cancelled. */
  offerId: string;
  /** Amount of the selling asset on offer (`"0"` cancels). A decimal string. */
  amount: string;
  /** Price of one selling unit in the buying asset, as Horizon reports it. */
  price: string;
  sellingAsset: string;
  buyingAsset: string;
  ledgerSeq: number;
  transactionHash?: string;
  timestamp?: string;
}

export interface OfferTradeEvent {
  kind: 'offer_trade';
  /** Unique per trade; used to ignore replays. */
  tradeId: string;
  offerId: string;
  /** The owner of the offer that was filled. */
  accountId: string;
  soldAsset: string;
  soldAmount: string;
  boughtAsset: string;
  boughtAmount: string;
  /** Execution price. */
  price: string;
  /** What is left on the offer after this trade, when known. Otherwise derived. */
  remainingAmount?: string;
  ledgerSeq: number;
  transactionHash?: string;
  timestamp?: string;
}

export type SdexEvent = OfferOperationEvent | OfferTradeEvent;

export type OfferStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED';

export interface TrackedOffer {
  offerId: string;
  accountId: string;
  status: OfferStatus;
  sellingAsset: string;
  buyingAsset: string;
  price: string;
  /** Amount the offer was created with, in stroops. */
  originalStroops: bigint;
  /** Amount still on offer, in stroops. `null` if it could not be determined. */
  remainingStroops: bigint | null;
  /** Total sold through fills, in stroops. */
  soldStroops: bigint;
  createdLedger: number;
  lastLedger: number;
  /** Ledger at which the offer first exceeded the whale threshold, or `null`. */
  whaleSinceLedger: number | null;
}

export type SdexAlertType =
  | 'OFFER_CREATED'
  | 'OFFER_UPDATED'
  | 'OFFER_PARTIALLY_FILLED'
  | 'OFFER_FILLED'
  | 'OFFER_CANCELLED'
  | 'WHALE_ORDER_PLACED'
  | 'SPOOFING_SUSPECTED';

export interface SdexAlert {
  type: SdexAlertType;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  accountId: string;
  offerId: string;
  sellingAsset: string | null;
  buyingAsset: string | null;
  ledgerSeq: number;
  transactionHash: string | null;
  /** Fills only: the executed price and the amounts that changed hands. */
  executedPrice: string | null;
  soldAmount: string | null;
  boughtAmount: string | null;
  remainingAmount: string | null;
  /** Whale and spoofing alerts: the XLM-equivalent size of the offer. */
  notionalXlm: string | null;
  /** Spoofing alerts: how many ledgers the offer lived for. */
  ledgersLive: number | null;
}

/** XLM value, in stroops, of an amount of an asset. `null` when the asset cannot be valued. */
export type XlmValuer = (asset: string, stroops: bigint) => bigint | null;

/** Values native XLM at par and everything else as unknown. */
export const nativeOnlyValuer: XlmValuer = (asset, stroops) =>
  asset === 'native' || asset === 'XLM' ? stroops : null;

export interface SdexTrackerOptions {
  /** Which accounts to alert for. Events for other accounts are ignored. */
  isMonitored: (accountId: string) => boolean;
  valueInXlm?: XlmValuer;
  /** An offer is a whale offer when it is worth MORE than this many XLM. Default 100,000. */
  whaleThresholdXlm?: bigint;
  /** A whale offer cancelled within this many ledgers, without trading, is flagged. Default 3. */
  spoofingWindowLedgers?: number;
}

export const DEFAULT_WHALE_THRESHOLD_XLM = 100_000n;
export const DEFAULT_SPOOFING_WINDOW_LEDGERS = 3;

export class SdexOfferTracker {
  private readonly offers = new Map<string, TrackedOffer>();
  private readonly seen = new Set<string>();
  private readonly valuer: XlmValuer;
  private readonly whaleThresholdStroops: bigint;
  private readonly spoofingWindow: number;

  constructor(private readonly options: SdexTrackerOptions) {
    this.valuer = options.valueInXlm ?? nativeOnlyValuer;
    this.whaleThresholdStroops = (options.whaleThresholdXlm ?? DEFAULT_WHALE_THRESHOLD_XLM) * STROOPS_PER_XLM;
    this.spoofingWindow = options.spoofingWindowLedgers ?? DEFAULT_SPOOFING_WINDOW_LEDGERS;
  }

  /** The tracked state of an offer, or `undefined`. */
  getOffer(offerId: string): TrackedOffer | undefined {
    const offer = this.offers.get(offerId);
    return offer ? { ...offer } : undefined;
  }

  /** Feeds one event and returns the alerts it produced, in order. */
  process(event: SdexEvent): SdexAlert[] {
    if (!this.options.isMonitored(event.accountId)) return [];

    const key = event.kind === 'offer_operation' ? `op:${event.operationId}` : `trade:${event.tradeId}`;
    if (this.seen.has(key)) return [];
    this.seen.add(key);

    return event.kind === 'offer_operation' ? this.onOperation(event) : this.onTrade(event);
  }

  private isWhale(asset: string, stroops: bigint): boolean {
    const value = this.valuer(asset, stroops);
    return value !== null && value > this.whaleThresholdStroops;
  }

  private notionalXlm(asset: string, stroops: bigint): string | null {
    const value = this.valuer(asset, stroops);
    return value === null ? null : formatXlm(value);
  }

  private onOperation(event: OfferOperationEvent): SdexAlert[] {
    const amount = parseStroops(event.amount);
    if (amount === null) return [];

    const existing = this.offers.get(event.offerId);
    if (existing && (existing.status === 'FILLED' || existing.status === 'CANCELLED')) return [];

    if (amount === 0n) return this.onCancel(event, existing);
    return existing ? this.onUpdate(event, existing, amount) : this.onCreate(event, amount);
  }

  private onCreate(event: OfferOperationEvent, amount: bigint): SdexAlert[] {
    const whale = this.isWhale(event.sellingAsset, amount);
    this.offers.set(event.offerId, {
      offerId: event.offerId,
      accountId: event.accountId,
      status: 'OPEN',
      sellingAsset: event.sellingAsset,
      buyingAsset: event.buyingAsset,
      price: event.price,
      originalStroops: amount,
      remainingStroops: amount,
      soldStroops: 0n,
      createdLedger: event.ledgerSeq,
      lastLedger: event.ledgerSeq,
      whaleSinceLedger: whale ? event.ledgerSeq : null,
    });

    const alerts = [this.alert('OFFER_CREATED', 'INFO', event, { remaining: amount })];
    if (whale) alerts.push(this.whaleAlert(event, amount));
    return alerts;
  }

  private onUpdate(event: OfferOperationEvent, offer: TrackedOffer, amount: bigint): SdexAlert[] {
    const becameWhale = offer.whaleSinceLedger === null && this.isWhale(offer.sellingAsset, amount);
    offer.price = event.price;
    offer.remainingStroops = amount;
    offer.lastLedger = event.ledgerSeq;
    if (becameWhale) offer.whaleSinceLedger = event.ledgerSeq;

    const alerts = [this.alert('OFFER_UPDATED', 'INFO', event, { remaining: amount })];
    if (becameWhale) alerts.push(this.whaleAlert(event, amount));
    return alerts;
  }

  private onCancel(event: OfferOperationEvent, offer: TrackedOffer | undefined): SdexAlert[] {
    if (!offer) {
      // Cancelling an offer that was not seen being created: report it, but there is no history
      // to judge a spoofing pattern against.
      return [this.alert('OFFER_CANCELLED', 'INFO', event, { remaining: 0n })];
    }

    offer.status = 'CANCELLED';
    offer.remainingStroops = 0n;
    offer.lastLedger = event.ledgerSeq;

    const alerts = [this.alert('OFFER_CANCELLED', 'INFO', event, { remaining: 0n })];

    const since = offer.whaleSinceLedger;
    if (since !== null && offer.soldStroops === 0n && event.ledgerSeq - since <= this.spoofingWindow) {
      alerts.push({
        ...this.alert('SPOOFING_SUSPECTED', 'CRITICAL', event, { remaining: 0n }),
        notionalXlm: this.notionalXlm(offer.sellingAsset, offer.originalStroops),
        ledgersLive: event.ledgerSeq - since,
      });
    }
    return alerts;
  }

  private onTrade(event: OfferTradeEvent): SdexAlert[] {
    const sold = parseStroops(event.soldAmount);
    if (sold === null) return [];

    const offer = this.offers.get(event.offerId);
    if (offer && (offer.status === 'FILLED' || offer.status === 'CANCELLED')) return [];

    let remaining: bigint | null = parseStroops(event.remainingAmount);
    if (remaining === null && offer && offer.remainingStroops !== null) {
      remaining = offer.remainingStroops > sold ? offer.remainingStroops - sold : 0n;
    }

    const filled = remaining === 0n;
    if (offer) {
      offer.soldStroops += sold;
      offer.remainingStroops = remaining;
      offer.lastLedger = event.ledgerSeq;
      offer.status = filled ? 'FILLED' : 'PARTIALLY_FILLED';
    }

    return [
      {
        type: filled ? 'OFFER_FILLED' : 'OFFER_PARTIALLY_FILLED',
        severity: 'INFO',
        accountId: event.accountId,
        offerId: event.offerId,
        sellingAsset: event.soldAsset,
        buyingAsset: event.boughtAsset,
        ledgerSeq: event.ledgerSeq,
        transactionHash: event.transactionHash ?? null,
        executedPrice: event.price,
        soldAmount: event.soldAmount,
        boughtAmount: event.boughtAmount,
        remainingAmount: remaining === null ? null : formatXlm(remaining),
        notionalXlm: null,
        ledgersLive: null,
      },
    ];
  }

  private whaleAlert(event: OfferOperationEvent, amount: bigint): SdexAlert {
    return {
      ...this.alert('WHALE_ORDER_PLACED', 'WARNING', event, { remaining: amount }),
      notionalXlm: this.notionalXlm(event.sellingAsset, amount),
    };
  }

  private alert(
    type: SdexAlertType,
    severity: SdexAlert['severity'],
    event: OfferOperationEvent,
    extra: { remaining: bigint },
  ): SdexAlert {
    return {
      type,
      severity,
      accountId: event.accountId,
      offerId: event.offerId,
      sellingAsset: event.sellingAsset,
      buyingAsset: event.buyingAsset,
      ledgerSeq: event.ledgerSeq,
      transactionHash: event.transactionHash ?? null,
      executedPrice: null,
      soldAmount: null,
      boughtAmount: null,
      remainingAmount: formatXlm(extra.remaining),
      notionalXlm: null,
      ledgersLive: null,
    };
  }
}
