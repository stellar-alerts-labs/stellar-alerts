import { describe, expect, it, vi } from 'vitest';
import {
  calculatePathPaymentSlippage,
  processPathPaymentOperation,
  type PathPaymentOperation,
} from '../path-payment-slippage-watcher.worker';

describe('Path Payment Slippage Alerting Worker (#424)', () => {
  it('calculates slippage for path_payment_strict_send correctly when actual receive is below min expectation', () => {
    const op: PathPaymentOperation = {
      id: 'path_op_101',
      type: 'path_payment_strict_send',
      sourceAccount: 'GAALICE',
      destinationAccount: 'GABOB',
      sendAsset: 'XLM',
      destAsset: 'USDC',
      path: ['USDT'],
      sendAmountOrMax: '100.0000000',
      destAmountOrMin: '10.0000000', // Expected minimum 10 USDC
      executedAmount: '9.5000000',  // Received 9.5 USDC (5% slippage shortfall)
      createdAt: new Date('2026-09-27T12:00:00.000Z'),
    };

    const alert = calculatePathPaymentSlippage(op, 1.0);
    expect(alert.slippagePercentage).toBe(5);
    expect(alert.slippageBps).toBe(500);
    expect(alert.exceedsThreshold).toBe(true);
  });

  it('calculates slippage for path_payment_strict_receive when actual send is above max expectation', () => {
    const op: PathPaymentOperation = {
      id: 'path_op_102',
      type: 'path_payment_strict_receive',
      sourceAccount: 'GAALICE',
      destinationAccount: 'GABOB',
      sendAsset: 'XLM',
      destAsset: 'EURC',
      path: [],
      sendAmountOrMax: '100.0000000', // Max willing to send: 100 XLM
      destAmountOrMin: '20.0000000',
      executedAmount: '103.0000000',  // Actually spent 103 XLM (3% slippage)
      createdAt: '2026-09-27T12:05:00.000Z',
    };

    const alert = calculatePathPaymentSlippage(op, 2.0);
    expect(alert.slippagePercentage).toBe(3);
    expect(alert.slippageBps).toBe(300);
    expect(alert.exceedsThreshold).toBe(true);
  });

  it('triggers notifier only when slippage exceeds threshold', async () => {
    const op: PathPaymentOperation = {
      id: 'path_op_103',
      type: 'path_payment_strict_send',
      sourceAccount: 'GAALICE',
      destinationAccount: 'GABOB',
      sendAsset: 'XLM',
      destAsset: 'USDC',
      sendAmountOrMax: '100.0000000',
      destAmountOrMin: '10.0000000',
      executedAmount: '9.9500000', // 0.5% slippage (below 1.0% threshold)
      createdAt: new Date(),
    };

    const notifyMock = vi.fn();
    const alert = await processPathPaymentOperation(op, 1.0, notifyMock);

    expect(alert.exceedsThreshold).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
