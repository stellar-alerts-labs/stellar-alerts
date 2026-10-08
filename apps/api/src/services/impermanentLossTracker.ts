/**
 * Automated Liquidity Pool Impermanent Loss Tracker (#1007)
 *
 * Tracks AMM liquidity-pool share balances across SDEX (classic protocol
 * `LiquidityPool` reserves) and Soroban DEX pools, and computes impermanent
 * loss (IL) against a HODL baseline — the value the depositor would hold had
 * they simply kept the two deposited token amounts instead of providing
 * liquidity.
 *
 * The engine is pure logic. Deposits and withdrawals mutate an in-memory
 * position (cost-basis in a common numeraire, e.g. USD), and each poll the
 * caller feeds the live pool reserves + spot prices to `computeImpermanentLoss`.
 * Alerts fire when the net IL crosses a user-defined risk threshold.
 *
 * Fees are intentionally excluded from the IL number itself; `netOfFeesPct`
 * layers accrued fee income on top so callers can reason about the position's
 * true P&L versus HODL.
 */

export type PoolVenue = 'SDEX' | 'SOROBAN';

export interface TokenPair {
  /** Human-readable code for token A (e.g. "XLM"). */
  token0: string;
  /** Human-readable code for token B (e.g. "USDC"). */
  token1: string;
}

export interface LiquidityDeposit {
  /** Token amounts contributed at deposit time. */
  amount0: number;
  amount1: number;
  /** LP shares minted for this deposit. */
  shares: number;
}

export interface PoolStateSnapshot {
  /** Live pool reserves. */
  reserve0: number;
  reserve1: number;
  /** Total LP shares outstanding for the pool. */
  totalShares: number;
  /** Spot prices in a common numeraire (e.g. USD) for each token. */
  price0: number;
  price1: number;
  ledgerSeq?: number;
}

export interface LiquidityPosition {
  positionId: string;
  userId: string;
  venue: PoolVenue;
  poolId: string;
  pair: TokenPair;
  /** Cumulative token amounts deposited (cost basis for the HODL baseline). */
  deposited0: number;
  deposited1: number;
  /** Current LP share balance held by the user. */
  shares: number;
  createdAtLedger?: number;
}

export type ImpermanentLossSeverity = 'OK' | 'WARNING' | 'CRITICAL';

export interface ImpermanentLossResult {
  positionId: string;
  userId: string;
  venue: PoolVenue;
  poolId: string;
  pair: TokenPair;
  /** User's current underlying token amounts implied by their share balance. */
  currentAmount0: number;
  currentAmount1: number;
  /** Current value of the LP position at spot prices. */
  lpValue: number;
  /** Value the user would hold had they never provided liquidity. */
  hodlValue: number;
  /** Signed IL fraction: negative = loss vs HODL (e.g. -0.05 = 5% worse). */
  impermanentLoss: number;
  /** IL expressed as a positive percentage magnitude of loss (0 if in profit). */
  impermanentLossPct: number;
  /** IL after adding accrued fee income (>= impermanentLoss). */
  netOfFeesPct: number;
  severity: ImpermanentLossSeverity;
}

export interface ImpermanentLossAlert extends ImpermanentLossResult {
  thresholdPct: number;
  message: string;
}

export interface ImpermanentLossTrackerOptions {
  /** IL loss magnitude (percent) at which a WARNING is raised. Default 5%. */
  warningThresholdPct?: number;
  /** IL loss magnitude (percent) at which a CRITICAL alert is raised. Default 10%. */
  criticalThresholdPct?: number;
}

/**
 * Closed-form impermanent loss for a 50/50 constant-product pool given the
 * price ratio change `r = priceNow / priceAtDeposit` of one token against the
 * other. Returns a signed fraction (<= 0). Exposed for verification/tests.
 *
 *   IL(r) = 2 * sqrt(r) / (1 + r) - 1
 */
export function constantProductIl(priceRatio: number): number {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return 0;
  return (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
}

export class ImpermanentLossTracker {
  private positions = new Map<string, LiquidityPosition>();
  private readonly warningThresholdPct: number;
  private readonly criticalThresholdPct: number;

  constructor(options: ImpermanentLossTrackerOptions = {}) {
    this.warningThresholdPct = options.warningThresholdPct ?? 5;
    this.criticalThresholdPct = options.criticalThresholdPct ?? 10;
  }

  /** Registers or replaces a position from an initial deposit. */
  public openPosition(params: {
    positionId: string;
    userId: string;
    venue: PoolVenue;
    poolId: string;
    pair: TokenPair;
    deposit: LiquidityDeposit;
    createdAtLedger?: number;
  }): LiquidityPosition {
    const position: LiquidityPosition = {
      positionId: params.positionId,
      userId: params.userId,
      venue: params.venue,
      poolId: params.poolId,
      pair: params.pair,
      deposited0: Math.max(0, params.deposit.amount0),
      deposited1: Math.max(0, params.deposit.amount1),
      shares: Math.max(0, params.deposit.shares),
      createdAtLedger: params.createdAtLedger,
    };
    this.positions.set(params.positionId, position);
    return position;
  }

  public getPosition(positionId: string): LiquidityPosition | undefined {
    return this.positions.get(positionId);
  }

  /** Adds a follow-up deposit, extending the cost basis and share balance. */
  public applyDeposit(positionId: string, deposit: LiquidityDeposit): LiquidityPosition | null {
    const position = this.positions.get(positionId);
    if (!position) return null;
    position.deposited0 += Math.max(0, deposit.amount0);
    position.deposited1 += Math.max(0, deposit.amount1);
    position.shares += Math.max(0, deposit.shares);
    return position;
  }

  /**
   * Removes `sharesRemoved` from the position, reducing the cost basis
   * proportionally so the remaining HODL baseline stays consistent. Removing all
   * (or more than) the shares deletes the position.
   */
  public applyWithdrawal(positionId: string, sharesRemoved: number): LiquidityPosition | null {
    const position = this.positions.get(positionId);
    if (!position) return null;

    const removed = Math.max(0, sharesRemoved);
    if (removed >= position.shares || position.shares === 0) {
      this.positions.delete(positionId);
      return null;
    }

    const remainingFraction = (position.shares - removed) / position.shares;
    position.deposited0 *= remainingFraction;
    position.deposited1 *= remainingFraction;
    position.shares -= removed;
    return position;
  }

  /**
   * Computes IL for a position against the current pool state. `accruedFees` is
   * the fee income (in the numeraire) earned by the position so far, used only
   * for the `netOfFeesPct` figure.
   */
  public computeImpermanentLoss(
    positionId: string,
    state: PoolStateSnapshot,
    accruedFees = 0,
  ): ImpermanentLossResult | null {
    const position = this.positions.get(positionId);
    if (!position) return null;
    return this.computeForPosition(position, state, accruedFees);
  }

  private computeForPosition(
    position: LiquidityPosition,
    state: PoolStateSnapshot,
    accruedFees: number,
  ): ImpermanentLossResult {
    const shareFraction =
      state.totalShares > 0 ? Math.min(1, position.shares / state.totalShares) : 0;

    const currentAmount0 = state.reserve0 * shareFraction;
    const currentAmount1 = state.reserve1 * shareFraction;

    const lpValue = currentAmount0 * state.price0 + currentAmount1 * state.price1;
    const hodlValue = position.deposited0 * state.price0 + position.deposited1 * state.price1;

    // Signed IL fraction. Guard the divide-by-zero HODL edge.
    const impermanentLoss = hodlValue > 0 ? (lpValue - hodlValue) / hodlValue : 0;
    const impermanentLossPct = impermanentLoss < 0 ? Math.abs(impermanentLoss) * 100 : 0;

    const feeFraction = hodlValue > 0 ? accruedFees / hodlValue : 0;
    const netOfFeesPct = (impermanentLoss + feeFraction) * 100;

    return {
      positionId: position.positionId,
      userId: position.userId,
      venue: position.venue,
      poolId: position.poolId,
      pair: position.pair,
      currentAmount0,
      currentAmount1,
      lpValue,
      hodlValue,
      impermanentLoss,
      impermanentLossPct: round(impermanentLossPct, 4),
      netOfFeesPct: round(netOfFeesPct, 4),
      severity: this.classify(impermanentLossPct),
    };
  }

  private classify(impermanentLossPct: number): ImpermanentLossSeverity {
    if (impermanentLossPct >= this.criticalThresholdPct) return 'CRITICAL';
    if (impermanentLossPct >= this.warningThresholdPct) return 'WARNING';
    return 'OK';
  }

  /**
   * Evaluates a position against a user-defined loss threshold (percent) and
   * returns an alert when the IL magnitude crosses it, otherwise null.
   */
  public evaluateThreshold(
    positionId: string,
    state: PoolStateSnapshot,
    thresholdPct: number,
    accruedFees = 0,
  ): ImpermanentLossAlert | null {
    const result = this.computeImpermanentLoss(positionId, state, accruedFees);
    if (!result) return null;
    if (result.impermanentLossPct < thresholdPct) return null;

    return {
      ...result,
      thresholdPct,
      message:
        `Impermanent loss on ${result.venue} pool ${result.poolId} ` +
        `(${result.pair.token0}/${result.pair.token1}) reached ${result.impermanentLossPct.toFixed(2)}% ` +
        `vs HODL (threshold ${thresholdPct}%). LP value ${round(result.lpValue, 2)} ` +
        `vs HODL ${round(result.hodlValue, 2)}.`,
    };
  }
}

function round(value: number, dp: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

export const impermanentLossTracker = new ImpermanentLossTracker();
