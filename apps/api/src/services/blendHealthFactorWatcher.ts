export interface BlendPosition {
  userAddress: string;
  poolId: string;
  collateralValueUsd: number;
  liquidationThresholdRatio: number; // e.g., 0.85
  borrowValueUsd: number;
}

export interface BlendLiquidationAlert {
  userAddress: string;
  poolId: string;
  healthFactor: number;
  severity: 'WARNING' | 'CRITICAL_LIQUIDATION_RISK';
  message: string;
}

export class BlendHealthFactorWatcher {
  private warningThreshold: number;
  private liquidationThreshold: number;

  constructor(warningThreshold: number = 1.15, liquidationThreshold: number = 1.05) {
    this.warningThreshold = warningThreshold;
    this.liquidationThreshold = liquidationThreshold;
  }

  public calculateHealthFactor(position: BlendPosition): number {
    if (position.borrowValueUsd <= 0) {
      return Infinity;
    }
    return (position.collateralValueUsd * position.liquidationThresholdRatio) / position.borrowValueUsd;
  }

  public evaluatePosition(position: BlendPosition): BlendLiquidationAlert | null {
    const hf = this.calculateHealthFactor(position);

    if (hf < this.liquidationThreshold) {
      return {
        userAddress: position.userAddress,
        poolId: position.poolId,
        healthFactor: Math.round(hf * 1000) / 1000,
        severity: 'CRITICAL_LIQUIDATION_RISK',
        message: `CRITICAL: Blend pool position for ${position.userAddress} is at immediate liquidation risk (HF = ${hf.toFixed(3)})!`,
      };
    }

    if (hf < this.warningThreshold) {
      return {
        userAddress: position.userAddress,
        poolId: position.poolId,
        healthFactor: Math.round(hf * 1000) / 1000,
        severity: 'WARNING',
        message: `WARNING: Blend pool position for ${position.userAddress} has low health factor (HF = ${hf.toFixed(3)}).`,
      };
    }

    return null;
  }
}
