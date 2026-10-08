import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { registerSupervisorHeartbeat } from './supervisor';

export const pathPaymentSlippageLifecycle = new WorkerLifecycleManager({
  workerName: 'PathPaymentSlippageWatcher',
  drainTimeoutMs: 10_000,
  maxInFlight: 10,
  autoRegisterSignals: true,
});

export type PathPaymentType = 'path_payment_strict_send' | 'path_payment_strict_receive';

export interface PathPaymentOperation {
  id: string;
  type: PathPaymentType;
  sourceAccount: string;
  destinationAccount: string;
  sendAsset: string;
  destAsset: string;
  path?: string[];
  /** Amount sent (strict_send) or max amount willing to send (strict_receive). */
  sendAmountOrMax: string;
  /** Amount received (strict_receive) or min amount willing to receive (strict_send). */
  destAmountOrMin: string;
  /** Actual executed amount received (strict_send) or actual executed send amount (strict_receive). */
  executedAmount: string;
  createdAt: Date | string;
}

export interface PathPaymentSlippageAlert {
  operationId: string;
  type: PathPaymentType;
  sourceAccount: string;
  destinationAccount: string;
  sendAsset: string;
  destAsset: string;
  path: string[];
  expectedLimitAmount: string;
  executedAmount: string;
  slippagePercentage: number;
  slippageBps: number;
  exceedsThreshold: boolean;
  timestamp: string;
}

export type SlippageNotifier = (alert: PathPaymentSlippageAlert) => Promise<void> | void;

export const defaultSlippageNotifier: SlippageNotifier = (alert) => {
  console.log(
    `[PathPaymentSlippageWatcher] ⚠️ Slippage Alert for ${alert.type} (op ${alert.operationId}): ` +
      `Slippage ${alert.slippagePercentage.toFixed(2)}% (${alert.slippageBps} bps) ` +
      `[Expected ${alert.expectedLimitAmount}, Executed ${alert.executedAmount}]`,
  );
};

/**
 * Calculates executed slippage percentage and bps for multi-hop path payments.
 *
 * - strict_receive: expected max send vs actual executed send amount.
 * - strict_send: expected min receive vs actual executed receive amount.
 */
export function calculatePathPaymentSlippage(
  op: PathPaymentOperation,
  thresholdPercentage: number = 1.0,
): PathPaymentSlippageAlert {
  const timestamp = op.createdAt instanceof Date ? op.createdAt.toISOString() : String(op.createdAt);
  const path = op.path ?? [];

  let expected = 0;
  let executed = 0;
  let slippageRatio = 0;

  if (op.type === 'path_payment_strict_receive') {
    // sendAmountOrMax is maximum willing to send; executedAmount is actual amount sent.
    expected = parseFloat(op.sendAmountOrMax);
    executed = parseFloat(op.executedAmount);
    // Slippage = extra amount spent over minimum needed
    slippageRatio = expected > 0 ? (executed - expected) / expected : 0;
  } else {
    // path_payment_strict_send: destAmountOrMin is minimum expected to receive; executedAmount is actual received.
    expected = parseFloat(op.destAmountOrMin);
    executed = parseFloat(op.executedAmount);
    // Slippage = shortfall below expected receive
    slippageRatio = expected > 0 ? (expected - executed) / expected : 0;
  }

  const slippagePercentage = Math.max(0, slippageRatio * 100);
  const slippageBps = Math.round(slippagePercentage * 100);
  const exceedsThreshold = slippagePercentage >= thresholdPercentage;

  return {
    operationId: op.id,
    type: op.type,
    sourceAccount: op.sourceAccount,
    destinationAccount: op.destinationAccount,
    sendAsset: op.sendAsset,
    destAsset: op.destAsset,
    path,
    expectedLimitAmount: op.type === 'path_payment_strict_receive' ? op.sendAmountOrMax : op.destAmountOrMin,
    executedAmount: op.executedAmount,
    slippagePercentage: parseFloat(slippagePercentage.toFixed(4)),
    slippageBps,
    exceedsThreshold,
    timestamp,
  };
}

export async function processPathPaymentOperation(
  op: PathPaymentOperation,
  thresholdPercentage: number = 1.0,
  notify: SlippageNotifier = defaultSlippageNotifier,
): Promise<PathPaymentSlippageAlert> {
  const alert = calculatePathPaymentSlippage(op, thresholdPercentage);
  if (alert.exceedsThreshold) {
    await notify(alert);
  }
  return alert;
}

export async function runPathPaymentSlippageWatcher() {
  console.log('[PathPaymentSlippageWatcher] 🚀 Starting Path Payment Slippage Alerting Worker...');
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runPathPaymentSlippageWatcher();
}
