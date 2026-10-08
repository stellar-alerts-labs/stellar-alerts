import { env } from '../config/env';
import {
  ImpermanentLossTracker,
  impermanentLossTracker,
  LiquidityPosition,
  PoolStateSnapshot,
  ImpermanentLossAlert,
} from '../services/impermanentLossTracker';
import { registerSupervisorHeartbeat } from './supervisor';

// #1007: watches tracked SDEX / Soroban DEX liquidity positions and dispatches
// an alert whenever a position's impermanent loss against its HODL baseline
// crosses the user-defined risk threshold.

const POLL_INTERVAL_MS = parseInt(env.IL_WATCHER_INTERVAL_MS || '60000', 10);
const DEFAULT_THRESHOLD_PCT = parseFloat(env.IL_WATCHER_DEFAULT_THRESHOLD_PCT || '5');

let isProcessing = false;

/** Pluggable so tests / future wiring can supply their own data sources. */
export type PoolStateResolver = (
  position: LiquidityPosition,
) => Promise<PoolStateSnapshot | null> | PoolStateSnapshot | null;

/** Resolves accrued fee income (in the numeraire) for a position, if known. */
export type AccruedFeesResolver = (
  position: LiquidityPosition,
) => Promise<number> | number;

/** Resolves the per-user IL alert threshold (percent) for a position. */
export type ThresholdResolver = (position: LiquidityPosition) => Promise<number> | number;

export type ImpermanentLossNotifier = (alert: ImpermanentLossAlert) => Promise<void> | void;

export const defaultImpermanentLossNotifier: ImpermanentLossNotifier = (alert) => {
  console.log(
    `[ILWatcher] 🔻 ${alert.userId} ${alert.venue} ${alert.poolId} ` +
      `(${alert.pair.token0}/${alert.pair.token1}) IL ${alert.impermanentLossPct.toFixed(2)}% ` +
      `>= ${alert.thresholdPct}% — ${alert.message}`,
  );
};

export interface ImpermanentLossPassDeps {
  tracker?: ImpermanentLossTracker;
  positions: LiquidityPosition[];
  resolveState: PoolStateResolver;
  resolveThreshold?: ThresholdResolver;
  resolveAccruedFees?: AccruedFeesResolver;
  notify?: ImpermanentLossNotifier;
}

/**
 * Evaluates every supplied position once. Kept fully injectable so the polling
 * loop, the tests, and any future persistence layer share the same logic.
 */
export async function runImpermanentLossPass(deps: ImpermanentLossPassDeps): Promise<ImpermanentLossAlert[]> {
  const tracker = deps.tracker ?? impermanentLossTracker;
  const notify = deps.notify ?? defaultImpermanentLossNotifier;
  const alerts: ImpermanentLossAlert[] = [];

  for (const position of deps.positions) {
    try {
      const state = await deps.resolveState(position);
      if (!state) continue;

      const thresholdPct = deps.resolveThreshold
        ? await deps.resolveThreshold(position)
        : DEFAULT_THRESHOLD_PCT;
      const accruedFees = deps.resolveAccruedFees ? await deps.resolveAccruedFees(position) : 0;

      const alert = tracker.evaluateThreshold(position.positionId, state, thresholdPct, accruedFees);
      if (alert) {
        alerts.push(alert);
        await notify(alert);
      }
    } catch (error: any) {
      console.error(
        `[ILWatcher] Error evaluating position ${position.positionId}:`,
        error?.message || error,
      );
    }
  }

  return alerts;
}

export async function runImpermanentLossWatcher(deps: Omit<ImpermanentLossPassDeps, 'positions'> & {
  loadPositions: () => Promise<LiquidityPosition[]> | LiquidityPosition[];
}) {
  console.log('[ILWatcher] 🚀 Starting Impermanent Loss Watcher...');

  const poll = async () => {
    if (isProcessing) {
      console.log('[ILWatcher] ⏳ Previous cycle still running. Skipping this pass.');
      return;
    }
    isProcessing = true;
    try {
      const positions = await deps.loadPositions();
      await runImpermanentLossPass({ ...deps, positions });
    } catch (error: any) {
      console.error('[ILWatcher] Polling pass error:', error?.message || error);
    } finally {
      isProcessing = false;
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  console.warn(
    '[ILWatcher] No pool-state / price resolver configured for standalone launch. ' +
      'Wire runImpermanentLossWatcher() with resolvers before enabling in production.',
  );
}
