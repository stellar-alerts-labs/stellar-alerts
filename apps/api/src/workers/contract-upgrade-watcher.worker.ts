import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { registerSupervisorHeartbeat } from './supervisor';

export const contractUpgradeLifecycle = new WorkerLifecycleManager({
  workerName: 'ContractUpgradeWatcher',
  drainTimeoutMs: 10_000,
  maxInFlight: 10,
  autoRegisterSignals: true,
});

export type ContractUpgradeEventType = 'UPGRADE_WASM' | 'ADMIN_CHANGE' | 'PROXY_MIGRATION';

export interface SorobanContractEvent {
  id: string;
  contractId: string;
  topic: string;
  oldWasmHash?: string;
  newWasmHash?: string;
  oldAdmin?: string;
  newAdmin?: string;
  txHash: string;
  ledgerSeq: number;
  timestamp: Date | string;
}

export interface ContractUpgradeAlert {
  eventType: ContractUpgradeEventType;
  eventId: string;
  contractId: string;
  topic: string;
  oldWasmHash?: string;
  newWasmHash?: string;
  oldAdmin?: string;
  newAdmin?: string;
  txHash: string;
  ledgerSeq: number;
  summary: string;
  timestamp: string;
}

export type UpgradeNotifier = (alert: ContractUpgradeAlert) => Promise<void> | void;

export const defaultUpgradeNotifier: UpgradeNotifier = (alert) => {
  console.log(
    `[ContractUpgradeWatcher] 🚨 Soroban Upgrade Event (${alert.eventType}) for Contract ${alert.contractId}: ${alert.summary}`,
  );
};

const UPGRADE_TOPICS = ['upgrade', 'set_wasm', 'update_wasm', 'wasm_updated'];
const ADMIN_TOPICS = ['change_admin', 'set_admin', 'transfer_admin', 'admin_changed'];

/**
 * Parses Soroban contract events for WASM upgrades or administrative authorization changes.
 */
export function evaluateContractUpgradeEvent(event: SorobanContractEvent): ContractUpgradeAlert | null {
  const timestamp = event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp);
  const topicLower = event.topic.toLowerCase();

  const isUpgrade = UPGRADE_TOPICS.some((t) => topicLower.includes(t));
  const isAdminChange = ADMIN_TOPICS.some((t) => topicLower.includes(t));

  if (!isUpgrade && !isAdminChange) {
    return null;
  }

  let eventType: ContractUpgradeEventType = 'PROXY_MIGRATION';
  let summary = `Contract ${event.contractId} event triggered topic '${event.topic}'.`;

  if (isUpgrade && event.newWasmHash) {
    eventType = 'UPGRADE_WASM';
    summary =
      `Contract WASM hash upgraded to ${event.newWasmHash}` +
      (event.oldWasmHash ? ` (previous: ${event.oldWasmHash})` : '');
  } else if (isAdminChange && event.newAdmin) {
    eventType = 'ADMIN_CHANGE';
    summary =
      `Contract admin transferred to ${event.newAdmin}` +
      (event.oldAdmin ? ` (previous: ${event.oldAdmin})` : '');
  }

  return {
    eventType,
    eventId: event.id,
    contractId: event.contractId,
    topic: event.topic,
    oldWasmHash: event.oldWasmHash,
    newWasmHash: event.newWasmHash,
    oldAdmin: event.oldAdmin,
    newAdmin: event.newAdmin,
    txHash: event.txHash,
    ledgerSeq: event.ledgerSeq,
    summary,
    timestamp,
  };
}

export async function processContractUpgradeEvent(
  event: SorobanContractEvent,
  notify: UpgradeNotifier = defaultUpgradeNotifier,
): Promise<ContractUpgradeAlert | null> {
  const alert = evaluateContractUpgradeEvent(event);
  if (alert) {
    await notify(alert);
  }
  return alert;
}

export async function runContractUpgradeWatcher() {
  console.log('[ContractUpgradeWatcher] 🚀 Starting Soroban Contract Upgrade Watcher...');
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runContractUpgradeWatcher();
}
