import { describe, expect, it } from 'vitest';
import {
  nativeOnlyValuer,
  SdexOfferTracker,
  type OfferOperationEvent,
  type OfferTradeEvent,
  type SdexAlert,
} from '../sdex-tracker.service';

const MAKER = 'GMAKER000000000000000000000000000000000000000000000000000';
const STRANGER = 'GSTRANGER0000000000000000000000000000000000000000000000';

let counter = 0;
function op(overrides: Partial<OfferOperationEvent> = {}): OfferOperationEvent {
  counter += 1;
  return {
    kind: 'offer_operation',
    operationId: `op-${counter}`,
    type: 'manage_sell_offer',
    accountId: MAKER,
    offerId: '100',
    amount: '1000.0000000',
    price: '0.5000000',
    sellingAsset: 'native',
    buyingAsset: 'USDC:GISSUER',
    ledgerSeq: 1_000,
    ...overrides,
  };
}

function trade(overrides: Partial<OfferTradeEvent> = {}): OfferTradeEvent {
  counter += 1;
  return {
    kind: 'offer_trade',
    tradeId: `trade-${counter}`,
    offerId: '100',
    accountId: MAKER,
    soldAsset: 'native',
    soldAmount: '400.0000000',
    boughtAsset: 'USDC:GISSUER',
    boughtAmount: '200.0000000',
    price: '0.5000000',
    ledgerSeq: 1_001,
    ...overrides,
  };
}

function tracker(extra: Partial<ConstructorParameters<typeof SdexOfferTracker>[0]> = {}) {
  return new SdexOfferTracker({ isMonitored: (id) => id === MAKER, ...extra });
}

const types = (alerts: SdexAlert[]) => alerts.map((a) => a.type);

describe('offer lifecycle', () => {
  it('creates an offer and reports it open with the full amount', () => {
    const t = tracker();

    const alerts = t.process(op());

    expect(types(alerts)).toEqual(['OFFER_CREATED']);
    expect(alerts[0]).toMatchObject({ offerId: '100', remainingAmount: '1000.0000000', ledgerSeq: 1_000 });
    expect(t.getOffer('100')).toMatchObject({ status: 'OPEN', originalStroops: 10_000_000_000n });
  });

  it('reports an update with the new remaining amount', () => {
    const t = tracker();
    t.process(op());

    const alerts = t.process(op({ amount: '600.0000000', price: '0.6000000', ledgerSeq: 1_005 }));

    expect(types(alerts)).toEqual(['OFFER_UPDATED']);
    expect(alerts[0].remainingAmount).toBe('600.0000000');
    expect(t.getOffer('100')).toMatchObject({ status: 'OPEN', price: '0.6000000', remainingStroops: 6_000_000_000n });
  });

  it('reports a partial fill with executed price, sold and bought amounts and offer id', () => {
    const t = tracker();
    t.process(op());

    const alerts = t.process(trade());

    expect(types(alerts)).toEqual(['OFFER_PARTIALLY_FILLED']);
    expect(alerts[0]).toMatchObject({
      offerId: '100',
      executedPrice: '0.5000000',
      soldAmount: '400.0000000',
      boughtAmount: '200.0000000',
      remainingAmount: '600.0000000',
    });
    expect(t.getOffer('100')?.status).toBe('PARTIALLY_FILLED');
  });

  it('moves from partially filled to filled when the remainder is taken', () => {
    const t = tracker();
    t.process(op());
    t.process(trade());

    const alerts = t.process(trade({ soldAmount: '600.0000000', boughtAmount: '300.0000000', ledgerSeq: 1_002 }));

    expect(types(alerts)).toEqual(['OFFER_FILLED']);
    expect(alerts[0].remainingAmount).toBe('0.0000000');
    expect(t.getOffer('100')).toMatchObject({ status: 'FILLED', remainingStroops: 0n, soldStroops: 10_000_000_000n });
  });

  it('uses the remaining amount the trade reports over its own arithmetic', () => {
    const t = tracker();
    t.process(op());

    const alerts = t.process(trade({ remainingAmount: '250.0000000' }));

    expect(alerts[0].remainingAmount).toBe('250.0000000');
  });

  it('treats a single trade for the whole amount as full execution', () => {
    const t = tracker();
    t.process(op());
    expect(types(t.process(trade({ soldAmount: '1000.0000000' })))).toEqual(['OFFER_FILLED']);
  });

  it('cancels an offer when an operation sets the amount to zero', () => {
    const t = tracker();
    t.process(op());

    const alerts = t.process(op({ amount: '0.0000000', ledgerSeq: 1_050 }));

    expect(types(alerts)).toEqual(['OFFER_CANCELLED']);
    expect(t.getOffer('100')).toMatchObject({ status: 'CANCELLED', remainingStroops: 0n });
  });

  it('cancels the open remainder of a partially filled offer', () => {
    const t = tracker();
    t.process(op());
    t.process(trade());

    expect(types(t.process(op({ amount: '0', ledgerSeq: 1_020 })))).toEqual(['OFFER_CANCELLED']);
    expect(t.getOffer('100')).toMatchObject({ status: 'CANCELLED', soldStroops: 4_000_000_000n });
  });

  it('ignores activity on an offer that is already filled or cancelled', () => {
    const filled = tracker();
    filled.process(op());
    filled.process(trade({ soldAmount: '1000' }));
    expect(filled.process(trade({ soldAmount: '1' }))).toEqual([]);
    expect(filled.process(op({ amount: '5' }))).toEqual([]);
    expect(filled.process(op({ amount: '0' }))).toEqual([]);

    const cancelled = tracker();
    cancelled.process(op());
    cancelled.process(op({ amount: '0' }));
    expect(cancelled.process(trade())).toEqual([]);
    expect(cancelled.getOffer('100')?.status).toBe('CANCELLED');
  });

  it.each(['manage_sell_offer', 'manage_buy_offer', 'create_passive_sell_offer'] as const)(
    'handles %s operations',
    (type) => {
      expect(types(tracker().process(op({ type, offerId: type })))).toEqual(['OFFER_CREATED']);
    },
  );

  it('keeps separate offers separate', () => {
    const t = tracker();
    t.process(op({ offerId: '1' }));
    t.process(op({ offerId: '2' }));

    t.process(trade({ offerId: '1', soldAmount: '1000' }));

    expect(t.getOffer('1')?.status).toBe('FILLED');
    expect(t.getOffer('2')?.status).toBe('OPEN');
  });
});

describe('monitored accounts and replays', () => {
  it('produces nothing for accounts that are not monitored', () => {
    const t = tracker();
    expect(t.process(op({ accountId: STRANGER }))).toEqual([]);
    expect(t.getOffer('100')).toBeUndefined();
  });

  it('ignores a replayed operation and a replayed trade', () => {
    const t = tracker();
    const create = op();
    const fill = trade();
    t.process(create);
    t.process(fill);

    expect(t.process(create)).toEqual([]);
    expect(t.process(fill)).toEqual([]);
    expect(t.getOffer('100')?.soldStroops).toBe(4_000_000_000n);
  });

  it('ignores operations with an unparseable amount', () => {
    expect(tracker().process(op({ amount: 'lots' }))).toEqual([]);
  });

  it('reports a fill for an offer it did not see created, without inventing a remainder', () => {
    const alerts = tracker().process(trade({ offerId: 'unseen' }));
    expect(types(alerts)).toEqual(['OFFER_PARTIALLY_FILLED']);
    expect(alerts[0].remainingAmount).toBeNull();
  });

  it('reports a cancellation of an offer it did not see created, without a spoofing judgement', () => {
    const alerts = tracker().process(op({ offerId: 'unseen', amount: '0' }));
    expect(types(alerts)).toEqual(['OFFER_CANCELLED']);
  });
});

describe('whale orders', () => {
  it('flags an offer worth more than 100,000 XLM when it is placed', () => {
    const alerts = tracker().process(op({ amount: '100000.0000001' }));

    expect(types(alerts)).toEqual(['OFFER_CREATED', 'WHALE_ORDER_PLACED']);
    expect(alerts[1]).toMatchObject({ severity: 'WARNING', notionalXlm: '100000.0000001', offerId: '100' });
  });

  it('does not flag an offer of exactly 100,000 XLM (the threshold is exclusive)', () => {
    expect(types(tracker().process(op({ amount: '100000.0000000' })))).toEqual(['OFFER_CREATED']);
  });

  it('flags an offer that is raised above the threshold by an update, once', () => {
    const t = tracker();
    t.process(op({ amount: '1000' }));

    expect(types(t.process(op({ amount: '200000', ledgerSeq: 1_010 })))).toEqual(['OFFER_UPDATED', 'WHALE_ORDER_PLACED']);
    expect(types(t.process(op({ amount: '300000', ledgerSeq: 1_011 })))).toEqual(['OFFER_UPDATED']);
    expect(t.getOffer('100')?.whaleSinceLedger).toBe(1_010);
  });

  it('honours a different threshold', () => {
    const t = tracker({ whaleThresholdXlm: 10n });
    expect(types(t.process(op({ amount: '11' })))).toEqual(['OFFER_CREATED', 'WHALE_ORDER_PLACED']);
  });

  it('values other assets through the injected valuer, and treats unknown values as not whale', () => {
    const t = tracker({
      valueInXlm: (asset, stroops) => (asset === 'USDC:GISSUER' ? stroops * 8n : nativeOnlyValuer(asset, stroops)),
    });
    expect(types(t.process(op({ offerId: 'usdc', sellingAsset: 'USDC:GISSUER', amount: '20000' })))).toEqual([
      'OFFER_CREATED',
      'WHALE_ORDER_PLACED',
    ]);
    expect(types(t.process(op({ offerId: 'junk', sellingAsset: 'JUNK:GX', amount: '999999999' })))).toEqual([
      'OFFER_CREATED',
    ]);
  });
});

describe('spoofing', () => {
  function placeWhale(t: SdexOfferTracker, ledgerSeq = 1_000) {
    return t.process(op({ amount: '500000', ledgerSeq }));
  }

  it('flags a whale offer cancelled within 3 ledgers without trading', () => {
    const t = tracker();
    placeWhale(t, 1_000);

    const alerts = t.process(op({ amount: '0', ledgerSeq: 1_003 }));

    expect(types(alerts)).toEqual(['OFFER_CANCELLED', 'SPOOFING_SUSPECTED']);
    expect(alerts[1]).toMatchObject({ severity: 'CRITICAL', ledgersLive: 3, notionalXlm: '500000.0000000' });
  });

  it('flags a whale offer cancelled in the same ledger', () => {
    const t = tracker();
    placeWhale(t, 1_000);
    expect(types(t.process(op({ amount: '0', ledgerSeq: 1_000 })))).toContain('SPOOFING_SUSPECTED');
  });

  it('does not flag a cancellation 4 ledgers later', () => {
    const t = tracker();
    placeWhale(t, 1_000);
    expect(types(t.process(op({ amount: '0', ledgerSeq: 1_004 })))).toEqual(['OFFER_CANCELLED']);
  });

  it('does not flag a whale offer that traded before it was cancelled', () => {
    const t = tracker();
    placeWhale(t, 1_000);
    t.process(trade({ soldAmount: '10', ledgerSeq: 1_001 }));
    expect(types(t.process(op({ amount: '0', ledgerSeq: 1_002 })))).toEqual(['OFFER_CANCELLED']);
  });

  it('does not flag a small offer cancelled straight away', () => {
    const t = tracker();
    t.process(op({ amount: '10', ledgerSeq: 1_000 }));
    expect(types(t.process(op({ amount: '0', ledgerSeq: 1_001 })))).toEqual(['OFFER_CANCELLED']);
  });

  it('measures the window from when the offer became a whale, not from when it was created', () => {
    const t = tracker();
    t.process(op({ amount: '10', ledgerSeq: 1_000 }));
    t.process(op({ amount: '500000', ledgerSeq: 1_100 }));

    expect(types(t.process(op({ amount: '0', ledgerSeq: 1_102 })))).toContain('SPOOFING_SUSPECTED');
  });

  it('honours a different window', () => {
    const t = tracker({ spoofingWindowLedgers: 10 });
    placeWhale(t, 1_000);
    expect(types(t.process(op({ amount: '0', ledgerSeq: 1_010 })))).toContain('SPOOFING_SUSPECTED');
  });
});
