export interface StateEntryTTL {
  keyHash: string;
  contractId: string;
  durability: 'PERSISTENT' | 'TEMPORARY';
  liveUntilLedger: number;
}

export interface StateArchivalAlert {
  keyHash: string;
  contractId: string;
  durability: string;
  liveUntilLedger: number;
  remainingLedgers: number;
  status: 'WARNING' | 'CRITICAL' | 'EVICTED';
  message: string;
}

export class StateArchivalWatcherEngine {
  private minLiveThreshold: number;

  constructor(minLiveThresholdLedgers: number = 17280) { // ~1 day at 5s/ledger
    this.minLiveThreshold = minLiveThresholdLedgers;
  }

  public checkEntryTTL(entry: StateEntryTTL, currentLedger: number): StateArchivalAlert | null {
    const remainingLedgers = entry.liveUntilLedger - currentLedger;

    if (remainingLedgers <= 0) {
      return {
        keyHash: entry.keyHash,
        contractId: entry.contractId,
        durability: entry.durability,
        liveUntilLedger: entry.liveUntilLedger,
        remainingLedgers: 0,
        status: 'EVICTED',
        message: `Soroban state entry ${entry.keyHash} for contract ${entry.contractId} has been evicted!`,
      };
    }

    if (remainingLedgers <= 1000) {
      return {
        keyHash: entry.keyHash,
        contractId: entry.contractId,
        durability: entry.durability,
        liveUntilLedger: entry.liveUntilLedger,
        remainingLedgers,
        status: 'CRITICAL',
        message: `CRITICAL: Soroban state entry ${entry.keyHash} will expire in ${remainingLedgers} ledgers!`,
      };
    }

    if (remainingLedgers <= this.minLiveThreshold) {
      return {
        keyHash: entry.keyHash,
        contractId: entry.contractId,
        durability: entry.durability,
        liveUntilLedger: entry.liveUntilLedger,
        remainingLedgers,
        status: 'WARNING',
        message: `WARNING: Soroban state entry ${entry.keyHash} is approaching TTL limit (${remainingLedgers} ledgers left).`,
      };
    }

    return null;
  }
}
