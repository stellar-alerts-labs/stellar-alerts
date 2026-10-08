import * as StellarSdk from 'stellar-sdk';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import {
  sorobanServer,
  getContractInstanceLedgerKey,
  getWasmHashFromContractInstance,
} from '../lib/soroban';
import {
  RestorationSentinelEngine,
  ContractRestorationAlert,
  ArchivableEntry,
} from '../services/restorationSentinel';
import { registerSupervisorHeartbeat } from './supervisor';

// #1005: ingestion sentinel that detects evicted Soroban contract instance and
// WASM code keys on watched contracts, prices the exact restoration fee, and
// emits a proactive warning before an invocation transaction would fail.

const POLL_INTERVAL_MS = parseInt(env.SOROBAN_RESTORATION_WORKER_INTERVAL_MS || '60000', 10);
const WARNING_THRESHOLD = parseInt(env.SOROBAN_RESTORATION_WARNING_LEDGERS || '17280', 10);
const CRITICAL_THRESHOLD = parseInt(env.SOROBAN_RESTORATION_CRITICAL_LEDGERS || '1000', 10);
const MIN_RESTORE_LEDGERS = parseInt(env.SOROBAN_RESTORATION_MIN_RESTORE_LEDGERS || '4096', 10);

let isProcessing = false;

export const restorationSentinelEngine = new RestorationSentinelEngine({
  warningThresholdLedgers: WARNING_THRESHOLD,
  criticalThresholdLedgers: CRITICAL_THRESHOLD,
  minRestoreLedgers: MIN_RESTORE_LEDGERS,
});

export type RestorationNotifier = (alert: ContractRestorationAlert) => Promise<void> | void;

export const defaultRestorationNotifier: RestorationNotifier = (alert) => {
  const tag = alert.requiresRestoration ? '🚨' : alert.severity === 'OK' ? '✅' : '⚠️';
  console.log(
    `[SorobanRestorationWorker] ${tag} ${alert.contractId.slice(0, 8)}... [${alert.severity}] ${alert.message}`,
  );
};

/** Measures the encoded byte size of a ledger entry's data. */
function entryByteSize(entry: { val?: StellarSdk.xdr.LedgerEntryData }): number {
  try {
    return entry.val ? entry.val.toXDR().length : 0;
  } catch {
    return 0;
  }
}

/**
 * Resolves the instance + code footprint of a contract from the Soroban RPC and
 * assesses it for eviction / restoration.
 */
export async function assessContractRestoration(
  contractId: string,
  latestLedger: number,
  engine: RestorationSentinelEngine = restorationSentinelEngine,
): Promise<ContractRestorationAlert | null> {
  const instanceKey = getContractInstanceLedgerKey(contractId);
  const instanceResponse = await sorobanServer.getLedgerEntries(instanceKey);

  const archivable: ArchivableEntry[] = [];

  if (instanceResponse?.entries?.length) {
    const instanceEntry = instanceResponse.entries[0];
    archivable.push({
      keyHash: instanceKey.toXDR('hex'),
      kind: 'INSTANCE',
      byteSize: entryByteSize(instanceEntry),
      liveUntilLedgerSeq: instanceEntry.liveUntilLedgerSeq ?? 0,
    });

    const wasmHash = getWasmHashFromContractInstance(instanceEntry.val);
    if (wasmHash) {
      const codeKey = StellarSdk.xdr.LedgerKey.contractCode(
        new StellarSdk.xdr.LedgerKeyContractCode({ hash: wasmHash }),
      );
      const codeResponse = await sorobanServer.getLedgerEntries(codeKey);
      if (codeResponse?.entries?.length) {
        const codeEntry = codeResponse.entries[0];
        archivable.push({
          keyHash: codeKey.toXDR('hex'),
          kind: 'CODE',
          byteSize: entryByteSize(codeEntry),
          liveUntilLedgerSeq: codeEntry.liveUntilLedgerSeq ?? 0,
        });
      }
    }
  }

  if (archivable.length === 0) {
    // No live instance entry found — it may already be evicted/archived. The RPC
    // does not return archived entries, so we surface this as a hard eviction.
    return {
      contractId,
      currentLedger: latestLedger,
      severity: 'EVICTED',
      requiresRestoration: true,
      entries: [],
      keysToRestore: [instanceKey.toXDR('hex')],
      totalRestorationFeeStroops: 0n,
      totalRestorationFeeXlm: '0.0000000',
      message:
        `Contract ${contractId} has no live instance entry in state; it is archived and must be ` +
        `restored before invocation.`,
    };
  }

  return engine.assessContractFootprint(contractId, archivable, latestLedger);
}

/** One poll pass over every active Soroban contract subscription. */
export async function runRestorationPass(notify: RestorationNotifier = defaultRestorationNotifier) {
  const subscriptions = await prisma.sorobanContractSubscription.findMany({
    where: { isActive: true },
    select: { contractId: true },
  });

  const contractIds = Array.from(new Set(subscriptions.map((s) => s.contractId)));
  if (contractIds.length === 0) {
    console.log('[SorobanRestorationWorker] No active contract subscriptions found. Pass complete.');
    return;
  }

  const latestLedger = await sorobanServer.getLatestLedger();
  const latestLedgerSeq = latestLedger.sequence;

  for (const contractId of contractIds) {
    try {
      const alert = await assessContractRestoration(contractId, latestLedgerSeq);
      // Only surface actionable states; healthy contracts stay quiet.
      if (alert && alert.severity !== 'OK') {
        await notify(alert);
      }
    } catch (error: any) {
      console.error(
        `[SorobanRestorationWorker] Error assessing contract ${contractId}:`,
        error?.message || error,
      );
    }
  }
}

export async function runRestorationWorker() {
  console.log('[SorobanRestorationWorker] 🚀 Starting Soroban Restoration Sentinel Worker...');

  const poll = async () => {
    if (isProcessing) {
      console.log('[SorobanRestorationWorker] ⏳ Previous cycle still running. Skipping this pass.');
      return;
    }
    isProcessing = true;
    try {
      await runRestorationPass();
    } catch (error: any) {
      console.error('[SorobanRestorationWorker] Polling pass error:', error?.message || error);
    } finally {
      isProcessing = false;
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runRestorationWorker();
}
