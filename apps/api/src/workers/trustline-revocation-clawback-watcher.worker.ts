import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { registerSupervisorHeartbeat } from './supervisor';

export const trustlineRevocationLifecycle = new WorkerLifecycleManager({
  workerName: 'TrustlineRevocationClawbackWatcher',
  drainTimeoutMs: 10_000,
  maxInFlight: 10,
  autoRegisterSignals: true,
});

export const AUTHORIZED_FLAG = 1;

export interface StellarOperation {
  id: string;
  type: string;
  sourceAccount: string;
  targetAccount?: string;
  assetCode?: string;
  assetIssuer?: string;
  amount?: string;
  clearFlags?: number[];
  setFlags?: number[];
  createdAt: Date | string;
}

export interface TrustlineRevocationAlert {
  eventType: 'REVOCATION' | 'CLAWBACK';
  operationId: string;
  issuer: string;
  targetAccount: string;
  assetCode: string;
  amount?: string;
  reason: string;
  timestamp: string;
}

export type RevocationClawbackNotifier = (alert: TrustlineRevocationAlert) => Promise<void> | void;

export const defaultRevocationClawbackNotifier: RevocationClawbackNotifier = (alert) => {
  console.log(
    `[TrustlineRevocationClawbackWatcher] 🚨 Alert (${alert.eventType}): Issuer ${alert.issuer} ` +
      `target ${alert.targetAccount} asset ${alert.assetCode} - ${alert.reason}`,
  );
};

/**
 * Inspects a Stellar operation and returns an alert payload if it represents a
 * trustline authorization revocation or asset clawback event.
 */
export function evaluateRevocationOrClawback(op: StellarOperation): TrustlineRevocationAlert | null {
  const timestamp = op.createdAt instanceof Date ? op.createdAt.toISOString() : String(op.createdAt);

  if (op.type === 'set_trust_line_flags' || op.type === 'set_options') {
    const clearFlags = op.clearFlags ?? [];
    if (clearFlags.includes(AUTHORIZED_FLAG)) {
      return {
        eventType: 'REVOCATION',
        operationId: op.id,
        issuer: op.sourceAccount,
        targetAccount: op.targetAccount ?? 'unknown',
        assetCode: op.assetCode ?? 'UNKNOWN',
        reason: 'Asset issuer revoked AUTHORIZED_FLAG for target account trustline.',
        timestamp,
      };
    }
  }

  if (op.type === 'clawback' || op.type === 'clawback_claimable_balance') {
    return {
      eventType: 'CLAWBACK',
      operationId: op.id,
      issuer: op.sourceAccount,
      targetAccount: op.targetAccount ?? 'unknown',
      assetCode: op.assetCode ?? 'UNKNOWN',
      amount: op.amount,
      reason: `Clawback executed by issuer for ${op.amount ?? 'unspecified'} base units.`,
      timestamp,
    };
  }

  return null;
}

export async function processOperation(
  op: StellarOperation,
  notify: RevocationClawbackNotifier = defaultRevocationClawbackNotifier,
): Promise<TrustlineRevocationAlert | null> {
  const alert = evaluateRevocationOrClawback(op);
  if (alert) {
    await notify(alert);
  }
  return alert;
}

export async function runTrustlineRevocationWatcher() {
  console.log('[TrustlineRevocationClawbackWatcher] 🚀 Starting Trustline Revocation & Clawback Watcher...');
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runTrustlineRevocationWatcher();
}
