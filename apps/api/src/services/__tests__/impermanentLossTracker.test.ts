import { describe, expect, it } from 'vitest';
import {
  ImpermanentLossTracker,
  constantProductIl,
  type PoolStateSnapshot,
  type TokenPair,
} from '../impermanentLossTracker';

// #1007: liquidity-pool impermanent loss tracker.
const PAIR: TokenPair = { token0: 'XLM', token1: 'USDC' };

function tracker() {
  return new ImpermanentLossTracker({ warningThresholdPct: 5, criticalThresholdPct: 10 });
}

describe('constantProductIl (#1007)', () => {
  it('is zero when the price ratio is unchanged', () => {
    expect(constantProductIl(1)).toBe(0);
  });

  it('matches the known closed-form values', () => {
    // r=2 -> ~-5.72% ; r=4 -> -20%
    expect(constantProductIl(2)).toBeCloseTo(-0.0572, 4);
    expect(constantProductIl(4)).toBeCloseTo(-0.2, 6);
  });

  it('is symmetric for reciprocal price moves', () => {
    expect(constantProductIl(2)).toBeCloseTo(constantProductIl(0.5), 6);
  });

  it('returns 0 for degenerate ratios', () => {
    expect(constantProductIl(0)).toBe(0);
    expect(constantProductIl(-3)).toBe(0);
    expect(constantProductIl(NaN)).toBe(0);
  });
});

describe('ImpermanentLossTracker.computeImpermanentLoss (#1007)', () => {
  it('reports no loss when reserves and prices are unchanged', () => {
    const t = tracker();
    t.openPosition({
      positionId: 'p1',
      userId: 'u1',
      venue: 'SOROBAN',
      poolId: 'CPOOL',
      pair: PAIR,
      deposit: { amount0: 100, amount1: 100, shares: 100 },
    });

    const state: PoolStateSnapshot = {
      reserve0: 100,
      reserve1: 100,
      totalShares: 100,
      price0: 1,
      price1: 1,
    };
    const result = t.computeImpermanentLoss('p1', state)!;

    expect(result.lpValue).toBeCloseTo(200, 6);
    expect(result.hodlValue).toBeCloseTo(200, 6);
    expect(result.impermanentLossPct).toBe(0);
    expect(result.severity).toBe('OK');
  });

  it('computes the ~5.72% IL for a 2x price move (matches closed form)', () => {
    const t = tracker();
    t.openPosition({
      positionId: 'p1',
      userId: 'u1',
      venue: 'SDEX',
      poolId: 'POOL_ABC',
      pair: PAIR,
      deposit: { amount0: 100, amount1: 100, shares: 100 },
    });

    // XLM ($1 -> $2) rebalances a constant-product pool to reserves 70.71 / 141.42.
    const state: PoolStateSnapshot = {
      reserve0: 70.7106781,
      reserve1: 141.4213562,
      totalShares: 100,
      price0: 2,
      price1: 1,
    };
    const result = t.computeImpermanentLoss('p1', state)!;

    expect(result.hodlValue).toBeCloseTo(300, 4);
    expect(result.lpValue).toBeCloseTo(282.84, 2);
    expect(result.impermanentLossPct).toBeCloseTo(5.72, 2);
    expect(result.severity).toBe('WARNING');
  });

  it('scales the underlying by the share fraction for a partial LP', () => {
    const t = tracker();
    t.openPosition({
      positionId: 'p1',
      userId: 'u1',
      venue: 'SOROBAN',
      poolId: 'CPOOL',
      pair: PAIR,
      deposit: { amount0: 25, amount1: 25, shares: 25 },
    });

    const state: PoolStateSnapshot = {
      reserve0: 100,
      reserve1: 100,
      totalShares: 100,
      price0: 1,
      price1: 1,
    };
    const result = t.computeImpermanentLoss('p1', state)!;

    // 25% of the pool -> 25 of each token, value 50.
    expect(result.currentAmount0).toBeCloseTo(25, 6);
    expect(result.lpValue).toBeCloseTo(50, 6);
  });
});

describe('ImpermanentLossTracker deposits & withdrawals (#1007)', () => {
  it('extends cost basis and shares on a follow-up deposit', () => {
    const t = tracker();
    t.openPosition({
      positionId: 'p1',
      userId: 'u1',
      venue: 'SDEX',
      poolId: 'POOL',
      pair: PAIR,
      deposit: { amount0: 100, amount1: 100, shares: 100 },
    });
    const pos = t.applyDeposit('p1', { amount0: 50, amount1: 50, shares: 50 })!;
    expect(pos.deposited0).toBe(150);
    expect(pos.shares).toBe(150);
  });

  it('reduces cost basis proportionally on a partial withdrawal', () => {
    const t = tracker();
    t.openPosition({
      positionId: 'p1',
      userId: 'u1',
      venue: 'SDEX',
      poolId: 'POOL',
      pair: PAIR,
      deposit: { amount0: 100, amount1: 200, shares: 100 },
    });
    const pos = t.applyWithdrawal('p1', 40)!;
    expect(pos.shares).toBe(60);
    expect(pos.deposited0).toBeCloseTo(60, 6);
    expect(pos.deposited1).toBeCloseTo(120, 6);
  });

  it('closes the position when all shares are withdrawn', () => {
    const t = tracker();
    t.openPosition({
      positionId: 'p1',
      userId: 'u1',
      venue: 'SDEX',
      poolId: 'POOL',
      pair: PAIR,
      deposit: { amount0: 100, amount1: 100, shares: 100 },
    });
    expect(t.applyWithdrawal('p1', 100)).toBeNull();
    expect(t.getPosition('p1')).toBeUndefined();
  });
});

describe('ImpermanentLossTracker.evaluateThreshold (#1007)', () => {
  const state: PoolStateSnapshot = {
    reserve0: 70.7106781,
    reserve1: 141.4213562,
    totalShares: 100,
    price0: 2,
    price1: 1,
  };

  function seeded() {
    const t = tracker();
    t.openPosition({
      positionId: 'p1',
      userId: 'u1',
      venue: 'SOROBAN',
      poolId: 'CPOOL',
      pair: PAIR,
      deposit: { amount0: 100, amount1: 100, shares: 100 },
    });
    return t;
  }

  it('alerts when IL crosses the user threshold', () => {
    const alert = seeded().evaluateThreshold('p1', state, 5);
    expect(alert).not.toBeNull();
    expect(alert!.thresholdPct).toBe(5);
    expect(alert!.message).toContain('Impermanent loss');
    expect(alert!.message).toContain('XLM/USDC');
  });

  it('stays quiet when IL is below the threshold', () => {
    expect(seeded().evaluateThreshold('p1', state, 10)).toBeNull();
  });

  it('offsets IL with accrued fees in netOfFeesPct', () => {
    const result = seeded().computeImpermanentLoss('p1', state, 30)!;
    // fees of 30 on a 300 HODL basis add +10% to the -5.72% IL.
    expect(result.netOfFeesPct).toBeCloseTo(4.28, 2);
  });
});
