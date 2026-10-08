import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { registerSupervisorHeartbeat } from './supervisor';

export const sorobanStorageProfilerLifecycle = new WorkerLifecycleManager({
  workerName: 'SorobanStorageProfiler',
  drainTimeoutMs: 10_000,
  maxInFlight: 10,
  autoRegisterSignals: true,
});

export type StorageTier = 'Persistent' | 'Instance' | 'Temporary';

export interface SorobanStorageEntry {
  key: string;
  tier: StorageTier;
  byteSize: number;
  liveUntilLedgerSeq?: number;
}

export interface StorageTierProfile {
  tier: StorageTier;
  entryCount: number;
  totalBytes: number;
  avgBytesPerEntry: number;
}

export interface ContractStorageFootprintProfile {
  contractId: string;
  totalEntries: number;
  totalBytes: number;
  byTier: Record<StorageTier, StorageTierProfile>;
}

export interface TtlExtensionEstimation {
  contractId: string;
  ledgersToExtend: number;
  rentFeePerBytePerLedgerStroops: bigint;
  totalRentFeeStroops: bigint;
  totalRentFeeXlm: string;
  tierBreakdownStroops: Record<StorageTier, bigint>;
}

/**
 * Computes an analytical footprint profile of a contract's storage entries by tier.
 */
export function profileContractStorage(
  contractId: string,
  entries: SorobanStorageEntry[],
): ContractStorageFootprintProfile {
  const tiers: StorageTier[] = ['Persistent', 'Instance', 'Temporary'];
  const byTier: Record<StorageTier, StorageTierProfile> = {
    Persistent: { tier: 'Persistent', entryCount: 0, totalBytes: 0, avgBytesPerEntry: 0 },
    Instance: { tier: 'Instance', entryCount: 0, totalBytes: 0, avgBytesPerEntry: 0 },
    Temporary: { tier: 'Temporary', entryCount: 0, totalBytes: 0, avgBytesPerEntry: 0 },
  };

  let totalBytes = 0;

  for (const entry of entries) {
    const tier = byTier[entry.tier];
    if (tier) {
      tier.entryCount += 1;
      tier.totalBytes += entry.byteSize;
      totalBytes += entry.byteSize;
    }
  }

  for (const t of tiers) {
    const p = byTier[t];
    p.avgBytesPerEntry = p.entryCount > 0 ? parseFloat((p.totalBytes / p.entryCount).toFixed(2)) : 0;
  }

  return {
    contractId,
    totalEntries: entries.length,
    totalBytes,
    byTier,
  };
}

/**
 * Computes exact rent renewal fees required to extend TTL for a contract footprint.
 */
export function estimateTtlExtensionCost(
  profile: ContractStorageFootprintProfile,
  ledgersToExtend: number,
  rentFeePerBytePerLedgerStroops: bigint = 100n,
): TtlExtensionEstimation {
  const tiers: StorageTier[] = ['Persistent', 'Instance', 'Temporary'];
  const tierBreakdownStroops: Record<StorageTier, bigint> = {
    Persistent: 0n,
    Instance: 0n,
    Temporary: 0n,
  };

  let totalRentFeeStroops = 0n;

  for (const t of tiers) {
    const bytes = BigInt(profile.byTier[t].totalBytes);
    const cost = bytes * BigInt(ledgersToExtend) * rentFeePerBytePerLedgerStroops;
    tierBreakdownStroops[t] = cost;
    totalRentFeeStroops += cost;
  }

  // 1 XLM = 10,000,000 stroops (7 decimals)
  const xlmWhole = totalRentFeeStroops / 10_000_000n;
  const xlmFrac = (totalRentFeeStroops % 10_000_000n).toString().padStart(7, '0');
  const totalRentFeeXlm = `${xlmWhole}.${xlmFrac}`;

  return {
    contractId: profile.contractId,
    ledgersToExtend,
    rentFeePerBytePerLedgerStroops,
    totalRentFeeStroops,
    totalRentFeeXlm,
    tierBreakdownStroops,
  };
}

export async function runSorobanStorageProfiler() {
  console.log('[SorobanStorageProfiler] 🚀 Starting Soroban Storage Footprint Profiler & TTL Estimator...');
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runSorobanStorageProfiler();
}
