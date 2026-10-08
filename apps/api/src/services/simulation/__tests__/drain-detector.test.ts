import { describe, expect, it } from 'vitest';
import { analyzeDrain } from '../drain-detector';
import type { AccountStateSnapshot, SimulatedOperation } from '../types';

const nativePre = (balance: string): AccountStateSnapshot => ({
  accountId: 'GABC',
  nativeBalance: balance,
  balances: [],
});

const opPay = (amount: string, dest = 'GDEST'): SimulatedOperation => ({
  kind: 'pay',
  destination: dest,
  asset: { type: 'native' },
  amount,
});

describe('drain-detector', () => {
  it('detects full drain from balance diff', () => {
    const pre = [nativePre('100.0000000')];
    const post = [{ accountId: 'GABC', nativeBalance: '0.0000000', balances: [] }];
    const result = analyzeDrain('GABC', [opPay('100.0000000')], pre, post, {
      nearTotalOutflowRatio: 0.85,
      fanOutDestinationThreshold: 3,
      sequentialTransferThreshold: 8,
      dustAmountStroops: 10n,
    });
    expect(result.analysis.drainedAssets.length).toBe(1);
    expect(result.indicators.length).toBeGreaterThan(0);
  });

  it('detects near-total drain', () => {
    const pre = [nativePre('100.0000000')];
    const post = [{ accountId: 'GABC', nativeBalance: '10.0000000', balances: [] }];
    const result = analyzeDrain('GABC', [opPay('90.0000000')], pre, post, {
      nearTotalOutflowRatio: 0.85,
      fanOutDestinationThreshold: 3,
      sequentialTransferThreshold: 8,
      dustAmountStroops: 10n,
    });
    expect(result.analysis.drainedAssets.length).toBe(1);
  });

  it('does not flag small transfers as drain', () => {
    const pre = [nativePre('100.0000000')];
    const post = [{ accountId: 'GABC', nativeBalance: '90.0000000', balances: [] }];
    const result = analyzeDrain('GABC', [opPay('10.0000000')], pre, post, {
      nearTotalOutflowRatio: 0.85,
      fanOutDestinationThreshold: 3,
      sequentialTransferThreshold: 8,
      dustAmountStroops: 10n,
    });
    expect(result.analysis.drainedAssets.length).toBe(0);
  });

  it('detects fan-out pattern', () => {
    const pre = [nativePre('100.0000000')];
    const post = [{ accountId: 'GABC', nativeBalance: '0.0000000', balances: [] }];
    const ops = [opPay('10.0000000', 'G1'), opPay('10.0000000', 'G2'), opPay('10.0000000', 'G3'), opPay('70.0000000', 'G4')];
    const result = analyzeDrain('GABC', ops, pre, post, {
      nearTotalOutflowRatio: 0.85,
      fanOutDestinationThreshold: 3,
      sequentialTransferThreshold: 8,
      dustAmountStroops: 10n,
    });
    const fanOut = result.indicators.find((i) => i.code === 'DESTINATION_FAN_OUT' || i.code === 'DRAIN_FAN_OUT');
    expect(fanOut).toBeDefined();
  });

  it('detects burst pattern', () => {
    const pre = [nativePre('1000.0000000')];
    const post = [{ accountId: 'GABC', nativeBalance: '0.0000000', balances: [] }];
    const ops = Array.from({ length: 10 }, (_, i) => opPay('100.0000000', `G${i}`));
    const result = analyzeDrain('GABC', ops, pre, post, {
      nearTotalOutflowRatio: 0.85,
      fanOutDestinationThreshold: 3,
      sequentialTransferThreshold: 8,
      dustAmountStroops: 10n,
    });
    const burst = result.indicators.find((i) => i.code === 'UNBOUNDED_SEQUENTIAL_TRANSFERS' || i.code === 'DRAIN_BURST');
    expect(burst).toBeDefined();
  });
});
