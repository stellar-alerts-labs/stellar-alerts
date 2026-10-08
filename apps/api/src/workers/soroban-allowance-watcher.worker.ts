import { prisma } from '../lib/prisma';
import {
  fetchContractEvents,
  getSorobanLatestLedger,
  parseApprovalEvent,
  ParsedSorobanApproval,
} from '../lib/soroban';
import { registerSupervisorHeartbeat } from './supervisor';

// #422: monitors SAC/custom SEP-41 token `approve` events for two distinct
// conditions — a high-value allowance being granted (a spender revocation
// candidate), and a previously-granted allowance approaching its expiration
// ledger (a renewal-or-let-lapse decision point for the token owner).

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_LOOKBACK_LEDGERS = 100;

/** Allowance amount (in the token's raw integer units) above which a newly
 *  granted approval is flagged, regardless of what asset it's denominated
 *  in — tokens vary too widely in decimals/value for one fixed amount to be
 *  meaningful across all of them, so this is deliberately a per-contract
 *  override via env, not a single global default guess. */
const HIGH_VALUE_ALLOWANCE_THRESHOLD = BigInt(
  process.env.SOROBAN_ALLOWANCE_HIGH_VALUE_THRESHOLD || '1000000000000',
);

/** How many ledgers before expiration a still-active allowance is flagged.
 *  ~5 ledgers/minute on Stellar, so the default (~17280 ledgers) is roughly
 *  a 2-day warning window. */
const EXPIRY_WARNING_LEDGERS = parseInt(
  process.env.SOROBAN_ALLOWANCE_EXPIRY_WARNING_LEDGERS || '17280',
  10,
);

export type AllowanceAlertType = 'HIGH_VALUE_GRANTED' | 'APPROACHING_EXPIRY';

export interface AllowanceAlert {
  alertType: AllowanceAlertType;
  contractId: string;
  from: string;
  spender: string;
  amount: string;
  liveUntilLedger: number;
  /** The underlying `approve` event's own ledger (not liveUntilLedger) —
   *  used as the persistence/dedup cursor so pagination advances with the
   *  event stream instead of jumping ahead to each approval's expiration. */
  eventLedgerSeq: number;
  ledgersUntilExpiry?: number;
  reason: string;
}

export type AllowanceNotifier = (alert: AllowanceAlert) => Promise<void> | void;

export const defaultAllowanceNotifier: AllowanceNotifier = (alert) => {
  console.log(
    `[SorobanAllowanceWatcher] 🚨 ${alert.alertType} on ${alert.contractId.slice(0, 8)}... ` +
      `${alert.from.slice(0, 8)}... -> ${alert.spender.slice(0, 8)}... amount=${alert.amount} - ${alert.reason}`,
  );
};

/**
 * Evaluates a freshly observed `approve` event: flags it when the newly
 * granted allowance is at or above the high-value threshold. Does not
 * evaluate expiry — a just-granted allowance's own live_until_ledger isn't
 * "approaching" anything yet from the grantor's perspective.
 */
export function evaluateNewApproval(
  approval: ParsedSorobanApproval,
  threshold: bigint = HIGH_VALUE_ALLOWANCE_THRESHOLD,
): AllowanceAlert | null {
  if (approval.rawAmount < threshold) return null;

  return {
    alertType: 'HIGH_VALUE_GRANTED',
    contractId: approval.contractId,
    from: approval.from,
    spender: approval.spender,
    amount: approval.amount,
    liveUntilLedger: approval.liveUntilLedger,
    eventLedgerSeq: approval.ledgerSeq ?? approval.liveUntilLedger,
    reason: `Allowance of ${approval.amount} granted to spender, at or above the configured high-value threshold.`,
  };
}

/**
 * Evaluates a previously-recorded approval against the current ledger:
 * flags it once it's within EXPIRY_WARNING_LEDGERS of live_until_ledger, but
 * not if it's already expired (nothing actionable left to renew) or was
 * revoked (amount 0 has nothing to warn about expiring).
 */
export function evaluateApprovalExpiry(
  approval: ParsedSorobanApproval,
  currentLedger: number,
  warningLedgers: number = EXPIRY_WARNING_LEDGERS,
): AllowanceAlert | null {
  if (approval.rawAmount <= 0n) return null;
  if (approval.liveUntilLedger <= currentLedger) return null;

  const ledgersUntilExpiry = approval.liveUntilLedger - currentLedger;
  if (ledgersUntilExpiry > warningLedgers) return null;

  return {
    alertType: 'APPROACHING_EXPIRY',
    contractId: approval.contractId,
    from: approval.from,
    spender: approval.spender,
    amount: approval.amount,
    liveUntilLedger: approval.liveUntilLedger,
    eventLedgerSeq: approval.ledgerSeq ?? approval.liveUntilLedger,
    ledgersUntilExpiry,
    reason: `Allowance of ${approval.amount} expires in ${ledgersUntilExpiry} ledgers (at ledger ${approval.liveUntilLedger}).`,
  };
}

export function getAllowanceWatchedContractIds(): string[] {
  const fromEnv = (process.env.SOROBAN_ALLOWANCE_CONTRACT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  return Array.from(new Set(fromEnv));
}

/**
 * Parses a batch of raw Soroban events into approval alerts for one
 * contract: every new `approve` event is checked for the high-value case,
 * and — since the same event batch already carries each approval's
 * live_until_ledger — also immediately checked against the expiry window
 * relative to `latestLedger`, so a large allowance granted with only a
 * short remaining TTL surfaces both alerts right away rather than only the
 * expiry warning on some future pass.
 */
export function detectAllowanceAlertsFromEventBatch(
  events: any[],
  latestLedger: number,
): AllowanceAlert[] {
  const alerts: AllowanceAlert[] = [];

  for (const rawEvent of events) {
    const approval = parseApprovalEvent(rawEvent);
    if (!approval) continue;

    const highValueAlert = evaluateNewApproval(approval);
    if (highValueAlert) alerts.push(highValueAlert);

    const expiryAlert = evaluateApprovalExpiry(approval, latestLedger);
    if (expiryAlert) alerts.push(expiryAlert);
  }

  return alerts;
}

/** Both alert types are stored with a distinct eventType so a high-value
 *  alert and an expiry alert for the very same underlying approve event
 *  (contractId, ledgerSeq, from, to, amount) don't collide on
 *  SorobanEventSnapshot's unique constraint and silently drop one of the
 *  two notifications. */
function snapshotEventType(alertType: AllowanceAlertType): string {
  return alertType === 'HIGH_VALUE_GRANTED' ? 'approve_high_value' : 'approve_expiry';
}

export async function processAllowanceContract(
  contractId: string,
  latestLedger: number,
  notify: AllowanceNotifier = defaultAllowanceNotifier,
) {
  const lastSnapshot = await prisma.sorobanEventSnapshot.findFirst({
    where: { contractId, eventType: { in: ['approve_high_value', 'approve_expiry'] } },
    orderBy: { ledgerSeq: 'desc' },
    select: { ledgerSeq: true },
  });

  const startLedger = lastSnapshot
    ? lastSnapshot.ledgerSeq + 1
    : Math.max(1, latestLedger - DEFAULT_LOOKBACK_LEDGERS);

  if (startLedger > latestLedger) return;

  const events = await fetchContractEvents(contractId, startLedger);
  const alerts = detectAllowanceAlertsFromEventBatch(events, latestLedger);

  for (const alert of alerts) {
    try {
      await prisma.sorobanEventSnapshot.create({
        data: {
          contractId,
          from: alert.from,
          to: alert.spender,
          amount: alert.amount,
          ledgerSeq: alert.eventLedgerSeq,
          eventType: snapshotEventType(alert.alertType),
        },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') continue;
      console.error(
        `[SorobanAllowanceWatcher] Failed to persist approval snapshot for ${contractId}:`,
        error?.message || error,
      );
      continue;
    }

    await notify(alert);
  }
}

export async function runAllowanceWatcherPass(notify: AllowanceNotifier = defaultAllowanceNotifier) {
  const contractIds = getAllowanceWatchedContractIds();
  if (contractIds.length === 0) {
    const subscriptions = await prisma.sorobanContractSubscription.findMany({
      where: { isActive: true, topic: { in: ['approve', 'allowance'] } },
      select: { contractId: true },
    });
    for (const subscription of subscriptions) {
      if (!contractIds.includes(subscription.contractId)) {
        contractIds.push(subscription.contractId);
      }
    }
  }

  if (contractIds.length === 0) return;

  const latestLedger = await getSorobanLatestLedger();
  if (latestLedger === 0) {
    console.warn('[SorobanAllowanceWatcher] Could not fetch latest Soroban ledger this pass, skipping');
    return;
  }

  for (const contractId of contractIds) {
    try {
      await processAllowanceContract(contractId, latestLedger, notify);
    } catch (error: any) {
      console.error(
        `[SorobanAllowanceWatcher] Failed to process contract ${contractId}:`,
        error?.message || error,
      );
    }
  }
}

export async function runAllowanceWatcher() {
  console.log('[SorobanAllowanceWatcher] 🚀 Starting Soroban Token Allowance Expiry & Revocation Watcher...');

  const poll = async () => {
    try {
      await runAllowanceWatcherPass();
    } catch (error: any) {
      console.error('[SorobanAllowanceWatcher] Polling error:', error?.message || error);
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runAllowanceWatcher();
}
