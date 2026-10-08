export interface HorizonNodeStatus {
  url: string;
  latestIngestedLedger: number;
  healthy: boolean;
  responseTimeMs: number;
}

export interface LagSentinelResult {
  activeNodeUrl: string;
  referenceLedger: number;
  lagLedgers: number;
  rotated: boolean;
  reason?: string;
}

export class HorizonLagSentinel {
  private nodeEndpoints: string[];
  private activeNodeIndex: number = 0;
  private maxAllowedLagLedgers: number;

  constructor(endpoints: string[], maxAllowedLagLedgers: number = 3) {
    if (endpoints.length === 0) {
      throw new Error('HorizonLagSentinel requires at least one endpoint');
    }
    this.nodeEndpoints = [...endpoints];
    this.maxAllowedLagLedgers = maxAllowedLagLedgers;
  }

  public getActiveEndpoint(): string {
    return this.nodeEndpoints[this.activeNodeIndex]!;
  }

  public evaluateNodes(nodesStatus: HorizonNodeStatus[], targetLatestLedger: number): LagSentinelResult {
    const currentNodeStatus = nodesStatus.find((n) => n.url === this.getActiveEndpoint());
    const currentLag = currentNodeStatus ? targetLatestLedger - currentNodeStatus.latestIngestedLedger : Infinity;

    if (currentNodeStatus && currentNodeStatus.healthy && currentLag <= this.maxAllowedLagLedgers) {
      return {
        activeNodeUrl: this.getActiveEndpoint(),
        referenceLedger: targetLatestLedger,
        lagLedgers: currentLag,
        rotated: false,
      };
    }

    // Node is lagging or unhealthy — find healthiest node with lowest lag
    let bestIndex = this.activeNodeIndex;
    let lowestLag = Infinity;

    for (let i = 0; i < this.nodeEndpoints.length; i++) {
      const status = nodesStatus.find((n) => n.url === this.nodeEndpoints[i]);
      if (status && status.healthy) {
        const lag = targetLatestLedger - status.latestIngestedLedger;
        if (lag < lowestLag) {
          lowestLag = lag;
          bestIndex = i;
        }
      }
    }

    const previousUrl = this.getActiveEndpoint();
    this.activeNodeIndex = bestIndex;
    const newUrl = this.getActiveEndpoint();

    return {
      activeNodeUrl: newUrl,
      referenceLedger: targetLatestLedger,
      lagLedgers: lowestLag === Infinity ? 0 : lowestLag,
      rotated: previousUrl !== newUrl,
      reason: previousUrl !== newUrl ? `Rotated from ${previousUrl} (lag: ${currentLag}) to ${newUrl}` : 'No healthier fallback available',
    };
  }
}
