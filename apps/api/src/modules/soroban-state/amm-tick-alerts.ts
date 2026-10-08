export type AmmProtocol = 'PHOENIX' | 'SOROSWAP';

export interface ConcentratedLiquidityTickConfig {
  poolAddress: string;
  protocol: AmmProtocol;
  lowerTick: number;
  upperTick: number;
  targetPriceMin: number;
  targetPriceMax: number;
  maxImbalanceRatio: number; // e.g. 0.85 = 85% reserve imbalance
}

export interface AmmEventData {
  poolAddress: string;
  protocol: AmmProtocol;
  currentTick: number;
  currentPrice: number;
  reserve0: number | bigint;
  reserve1: number | bigint;
  swapAmount0?: number;
  swapAmount1?: number;
  ledgerSeq: number;
  timestamp: Date;
}

export interface AmmTickAlertResult {
  poolAddress: string;
  protocol: AmmProtocol;
  ledgerSeq: number;
  tickCrossed: 'LOWER' | 'UPPER' | 'NONE';
  priceAlert: 'BELOW_MIN' | 'ABOVE_MAX' | 'NORMAL';
  imbalanceRatio: number;
  isImbalanced: boolean;
  alertTriggered: boolean;
  alertMessages: string[];
}

export class AmmTickAlertMonitor {
  private configs: Map<string, ConcentratedLiquidityTickConfig> = new Map();

  public registerPoolConfig(config: ConcentratedLiquidityTickConfig): void {
    this.configs.set(config.poolAddress.toLowerCase(), config);
  }

  public getPoolConfig(poolAddress: string): ConcentratedLiquidityTickConfig | undefined {
    return this.configs.get(poolAddress.toLowerCase());
  }

  public calculateReserveImbalance(reserve0: number | bigint, reserve1: number | bigint): number {
    const r0 = Number(reserve0);
    const r1 = Number(reserve1);
    const total = r0 + r1;

    if (total === 0) return 0;
    const ratio0 = r0 / total;
    const ratio1 = r1 / total;
    return Math.abs(ratio0 - ratio1);
  }

  public evaluateAmmEvent(event: AmmEventData): AmmTickAlertResult {
    const poolKey = event.poolAddress.toLowerCase();
    const config = this.configs.get(poolKey);

    const imbalanceRatio = this.calculateReserveImbalance(event.reserve0, event.reserve1);
    const alertMessages: string[] = [];

    let tickCrossed: 'LOWER' | 'UPPER' | 'NONE' = 'NONE';
    let priceAlert: 'BELOW_MIN' | 'ABOVE_MAX' | 'NORMAL' = 'NORMAL';
    let isImbalanced = false;

    if (config) {
      if (event.currentTick < config.lowerTick) {
        tickCrossed = 'LOWER';
        alertMessages.push(
          `Tick boundary crossed below lower threshold (${event.currentTick} < ${config.lowerTick}) on ${event.protocol} pool ${event.poolAddress}`
        );
      } else if (event.currentTick > config.upperTick) {
        tickCrossed = 'UPPER';
        alertMessages.push(
          `Tick boundary crossed above upper threshold (${event.currentTick} > ${config.upperTick}) on ${event.protocol} pool ${event.poolAddress}`
        );
      }

      if (event.currentPrice < config.targetPriceMin) {
        priceAlert = 'BELOW_MIN';
        alertMessages.push(
          `Pool price fell below minimum target (${event.currentPrice} < ${config.targetPriceMin}) on ${event.poolAddress}`
        );
      } else if (event.currentPrice > config.targetPriceMax) {
        priceAlert = 'ABOVE_MAX';
        alertMessages.push(
          `Pool price breached maximum target (${event.currentPrice} > ${config.targetPriceMax}) on ${event.poolAddress}`
        );
      }

      if (imbalanceRatio > config.maxImbalanceRatio) {
        isImbalanced = true;
        alertMessages.push(
          `Reserve imbalance ratio reached ${(imbalanceRatio * 100).toFixed(1)}% (exceeds max ${config.maxImbalanceRatio * 100}%) on ${event.poolAddress}`
        );
      }
    } else {
      // Default checks if no explicit config registered
      if (imbalanceRatio > 0.8) {
        isImbalanced = true;
        alertMessages.push(
          `High reserve imbalance ratio ${(imbalanceRatio * 100).toFixed(1)}% detected on pool ${event.poolAddress}`
        );
      }
    }

    const alertTriggered = alertMessages.length > 0;

    return {
      poolAddress: event.poolAddress,
      protocol: event.protocol,
      ledgerSeq: event.ledgerSeq,
      tickCrossed,
      priceAlert,
      imbalanceRatio,
      isImbalanced,
      alertTriggered,
      alertMessages,
    };
  }

  public batchProcessEvents(events: AmmEventData[]): AmmTickAlertResult[] {
    return events.map((ev) => this.evaluateAmmEvent(ev));
  }
}

export const ammTickAlertMonitor = new AmmTickAlertMonitor();
