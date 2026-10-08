import {
  evaluateOfferCancellation,
  evaluateOfferInactivity,
  detectCancellationsFromOperationBatch,
  detectStaleOffers,
  type StellarOfferOperation,
  type OpenSdexOffer,
} from '../sdex-offer-watcher.worker';

function makeOp(overrides: Partial<StellarOfferOperation> = {}): StellarOfferOperation {
  return {
    id: 'op_1',
    type: 'manage_sell_offer',
    sourceAccount: 'GASELLER1',
    offerId: '555',
    amount: '100',
    sellingAssetCode: 'USDC',
    buyingAssetCode: 'XLM',
    createdAt: new Date('2026-09-27T00:00:00.000Z'),
    ...overrides,
  };
}

function makeOffer(overrides: Partial<OpenSdexOffer> = {}): OpenSdexOffer {
  return {
    offerId: '555',
    sellerAccount: 'GASELLER1',
    sellingAssetCode: 'USDC',
    buyingAssetCode: 'XLM',
    amount: '100',
    price: '1.5',
    lastModifiedAt: new Date('2026-09-27T00:00:00.000Z'),
    ...overrides,
  };
}

describe('evaluateOfferCancellation (#423)', () => {
  it('flags a manage_sell_offer that zeroes an existing offer', () => {
    const alert = evaluateOfferCancellation(makeOp({ amount: '0' }));
    expect(alert).not.toBeNull();
    expect(alert?.alertType).toBe('CANCELLED');
    expect(alert?.offerId).toBe('555');
  });

  it('flags a manage_buy_offer that zeroes an existing offer', () => {
    const alert = evaluateOfferCancellation(
      makeOp({ type: 'manage_buy_offer', amount: '0' }),
    );
    expect(alert).not.toBeNull();
  });

  it('does not flag a non-zero amount update', () => {
    expect(evaluateOfferCancellation(makeOp({ amount: '50' }))).toBeNull();
  });

  it('does not flag a brand-new offer (offerId 0) even with amount 0', () => {
    expect(evaluateOfferCancellation(makeOp({ offerId: '0', amount: '0' }))).toBeNull();
  });

  it('does not flag a create_passive_sell_offer operation', () => {
    expect(
      evaluateOfferCancellation(makeOp({ type: 'create_passive_sell_offer', amount: '0' })),
    ).toBeNull();
  });

  it('does not flag an unrelated operation type', () => {
    expect(evaluateOfferCancellation(makeOp({ type: 'payment', amount: '0' }))).toBeNull();
  });
});

describe('evaluateOfferInactivity (#423)', () => {
  it('flags an offer untouched beyond the threshold', () => {
    const offer = makeOffer({ lastModifiedAt: new Date('2026-09-01T00:00:00.000Z') });
    const now = new Date('2026-09-27T00:00:00.000Z');
    const alert = evaluateOfferInactivity(offer, now, 3 * 24 * 60 * 60);
    expect(alert).not.toBeNull();
    expect(alert?.alertType).toBe('STALE_INACTIVE');
    expect(alert?.inactiveSeconds).toBeGreaterThan(3 * 24 * 60 * 60);
  });

  it('does not flag a recently-touched offer', () => {
    const offer = makeOffer({ lastModifiedAt: new Date('2026-09-26T23:00:00.000Z') });
    const now = new Date('2026-09-27T00:00:00.000Z');
    expect(evaluateOfferInactivity(offer, now, 3 * 24 * 60 * 60)).toBeNull();
  });

  it('accepts a string lastModifiedAt the same as a Date', () => {
    const offer = makeOffer({ lastModifiedAt: '2026-09-01T00:00:00.000Z' });
    const now = new Date('2026-09-27T00:00:00.000Z');
    expect(evaluateOfferInactivity(offer, now, 3 * 24 * 60 * 60)).not.toBeNull();
  });
});

describe('detectCancellationsFromOperationBatch / detectStaleOffers (#423)', () => {
  it('filters a mixed operation batch down to only cancellations', () => {
    const ops = [makeOp({ amount: '0' }), makeOp({ id: 'op_2', amount: '75' })];
    const alerts = detectCancellationsFromOperationBatch(ops);
    expect(alerts).toHaveLength(1);
  });

  it('filters a mixed offer set down to only stale ones', () => {
    const now = new Date('2026-09-27T00:00:00.000Z');
    const offers = [
      makeOffer({ offerId: '1', lastModifiedAt: new Date('2026-09-01T00:00:00.000Z') }),
      makeOffer({ offerId: '2', lastModifiedAt: new Date('2026-09-26T23:59:00.000Z') }),
    ];
    const alerts = detectStaleOffers(offers, now, 3 * 24 * 60 * 60);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].offerId).toBe('1');
  });
});
