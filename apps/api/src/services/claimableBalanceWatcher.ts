export interface Claimant {
  destination: string;
  predicate: Record<string, unknown>;
}

export interface ClaimableBalanceEntry {
  id: string;
  asset: string;
  amount: string;
  sponsor: string;
  claimants: Claimant[];
  lastModifiedLedger: number;
}

export interface ClaimableBalanceAlert {
  balanceId: string;
  claimantAddress: string;
  asset: string;
  amount: string;
  type: 'CREATED' | 'EXPIRING_SOON' | 'EXPIRED';
  message: string;
}

export class ClaimableBalanceWatcher {
  private monitoredAddresses: Set<string> = new Set();

  constructor(monitoredAddresses: string[] = []) {
    monitoredAddresses.forEach((addr) => this.monitoredAddresses.add(addr));
  }

  public addMonitoredAddress(address: string): void {
    this.monitoredAddresses.add(address);
  }

  public processBalance(balance: ClaimableBalanceEntry, currentLedger: number): ClaimableBalanceAlert[] {
    const alerts: ClaimableBalanceAlert[] = [];

    for (const claimant of balance.claimants) {
      if (!this.monitoredAddresses.has(claimant.destination)) {
        continue;
      }

      // Check if newly created
      alerts.push({
        balanceId: balance.id,
        claimantAddress: claimant.destination,
        asset: balance.asset,
        amount: balance.amount,
        type: 'CREATED',
        message: `New claimable balance ${balance.id} created for ${claimant.destination}`,
      });

      // Check predicate expiration
      if (claimant.predicate.absBeforeLedger && typeof claimant.predicate.absBeforeLedger === 'number') {
        const expiresAtLedger = claimant.predicate.absBeforeLedger;
        const ledgersRemaining = expiresAtLedger - currentLedger;

        if (ledgersRemaining <= 0) {
          alerts.push({
            balanceId: balance.id,
            claimantAddress: claimant.destination,
            asset: balance.asset,
            amount: balance.amount,
            type: 'EXPIRED',
            message: `Claimable balance ${balance.id} expired at ledger ${expiresAtLedger}`,
          });
        } else if (ledgersRemaining <= 100) {
          alerts.push({
            balanceId: balance.id,
            claimantAddress: claimant.destination,
            asset: balance.asset,
            amount: balance.amount,
            type: 'EXPIRING_SOON',
            message: `Claimable balance ${balance.id} expires in ${ledgersRemaining} ledgers`,
          });
        }
      }
    }

    return alerts;
  }
}
