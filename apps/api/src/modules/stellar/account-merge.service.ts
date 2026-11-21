/**
 * Account merge forensics (#980).
 *
 * `account_merge` permanently deletes the source account and moves its remaining XLM to the
 * destination. The watcher for the deleted account has nothing left to stream, so this module
 * turns the operation into an alert, records where the balance went, and moves the wallet to a
 * `MERGED` state linked to the beneficiary.
 *
 * It is pure logic over a small injected store, so it can be unit tested without Horizon or a
 * database. Wiring it into the watcher worker and persisting `MERGED` in Prisma are separate
 * steps that need a schema migration.
 */

import { formatXlm, parseStroops } from './amounts';

export type WalletStatus = 'ACTIVE' | 'MERGED';

/** A Horizon-style `account_merge` operation record. */
export interface AccountMergeOperation {
  id: string;
  type: string;
  /** The account that is destroyed. Horizon also reports it as `account`. */
  source_account: string;
  /** The beneficiary that receives the swept balance. */
  into: string;
  transaction_hash: string;
  /** Sequence of the ledger the operation closed in. */
  ledger: number;
  created_at?: string;
}

/** A Horizon-style effect record. The swept amount is reported on `account_credited`. */
export interface MergeEffect {
  type: string;
  account: string;
  asset_type?: string;
  amount?: string;
}

export interface AccountMergeEvent {
  operationId: string;
  transactionHash: string;
  ledgerSeq: number;
  /** The destroyed account. */
  sourceAccount: string;
  /** The account that received the swept XLM. */
  destinationAccount: string;
  /** Swept XLM in stroops, exact. `null` when the credit effect was not available. */
  sweptStroops: bigint | null;
  /** Swept XLM as a 7-decimal string, or `null` with `sweptStroops`. */
  sweptXlm: string | null;
  occurredAt: string | null;
}

export type MergeRole = 'SOURCE_DESTROYED' | 'DESTINATION_RECEIVED';

export interface AccountMergeAlert {
  type: 'ACCOUNT_MERGED_AWAY' | 'ACCOUNT_MERGE_RECEIVED';
  severity: 'CRITICAL' | 'INFO';
  role: MergeRole;
  /** The monitored account the alert is for. */
  monitoredAccount: string;
  sourceAccount: string;
  destinationAccount: string;
  sweptXlm: string | null;
  sweptStroops: string | null;
  ledgerSeq: number;
  transactionHash: string;
  operationId: string;
  occurredAt: string | null;
}

/** What is persisted when a wallet is destroyed. */
export interface MergedWalletRecord {
  status: 'MERGED';
  mergedIntoAccount: string;
  mergedAtLedger: number;
  sweptStroops: string | null;
  mergeTransactionHash: string;
}

export interface AccountMergeStore {
  /** Current lifecycle record of a monitored wallet, or `null` if it is not monitored. */
  getWalletStatus(accountId: string): Promise<WalletStatus | null>;
  /** Persists the `MERGED` state and the link to the destination. */
  markMerged(accountId: string, record: MergedWalletRecord): Promise<void>;
  /** Whether an operation has already been processed (idempotency across replays). */
  hasProcessed(operationId: string): Promise<boolean>;
  markProcessed(operationId: string): Promise<void>;
  /** Whether a trace watcher already exists for the account. */
  isWatched(accountId: string): Promise<boolean>;
}

export interface AccountMergeTrackerOptions {
  /** Start a trace watcher on the beneficiary of a merged monitored wallet. Default off. */
  autoTraceBeneficiary?: boolean;
  /** Called to create the trace watcher. Required when `autoTraceBeneficiary` is on. */
  spawnTraceWatcher?: (beneficiary: string, origin: AccountMergeEvent) => Promise<void>;
}

export interface AccountMergeResult {
  event: AccountMergeEvent;
  alerts: AccountMergeAlert[];
  /** The wallets moved to `MERGED` by this operation. */
  walletsMerged: string[];
  /** The beneficiary a trace watcher was started on, if any. */
  tracedBeneficiary: string | null;
  /** True when the operation was seen before and nothing was done. */
  duplicate: boolean;
}

export { parseStroops, formatXlm } from './amounts';

export function isAccountMergeOperation(op: { type?: string }): boolean {
  return op?.type === 'account_merge';
}

/**
 * Parses an `account_merge` operation and its effects. The swept amount is the native
 * `account_credited` effect on the destination; it is `null` if the effect is missing, so a
 * caller can see that the amount was not resolved instead of reading a false zero.
 */
export function parseAccountMerge(
  op: AccountMergeOperation,
  effects: readonly MergeEffect[] = [],
): AccountMergeEvent | null {
  if (!isAccountMergeOperation(op) || !op.source_account || !op.into) return null;

  const credited = effects.find(
    (effect) =>
      effect.type === 'account_credited' &&
      effect.account === op.into &&
      (effect.asset_type === undefined || effect.asset_type === 'native'),
  );
  const sweptStroops = parseStroops(credited?.amount);

  return {
    operationId: op.id,
    transactionHash: op.transaction_hash,
    ledgerSeq: op.ledger,
    sourceAccount: op.source_account,
    destinationAccount: op.into,
    sweptStroops,
    sweptXlm: sweptStroops === null ? null : formatXlm(sweptStroops),
    occurredAt: op.created_at ?? null,
  };
}

/**
 * The lifecycle transition for a wallet that was the source of a merge. `MERGED` is terminal and
 * the transition is idempotent: merging a `MERGED` wallet changes nothing.
 */
export function nextWalletStatus(current: WalletStatus): { status: WalletStatus; changed: boolean } {
  return current === 'MERGED' ? { status: 'MERGED', changed: false } : { status: 'MERGED', changed: true };
}

export class AccountMergeTracker {
  constructor(
    private readonly store: AccountMergeStore,
    private readonly options: AccountMergeTrackerOptions = {},
  ) {
    if (options.autoTraceBeneficiary && !options.spawnTraceWatcher) {
      throw new Error('autoTraceBeneficiary requires spawnTraceWatcher');
    }
  }

  /**
   * Handles one operation. Non-merge operations and merges that involve no monitored account
   * produce no alerts. A monitored account is one `store.getWalletStatus` knows about.
   */
  async process(op: AccountMergeOperation, effects: readonly MergeEffect[] = []): Promise<AccountMergeResult | null> {
    const event = parseAccountMerge(op, effects);
    if (!event) return null;

    const empty: AccountMergeResult = {
      event,
      alerts: [],
      walletsMerged: [],
      tracedBeneficiary: null,
      duplicate: false,
    };

    if (await this.store.hasProcessed(event.operationId)) return { ...empty, duplicate: true };

    const sourceStatus = await this.store.getWalletStatus(event.sourceAccount);
    const destinationStatus = await this.store.getWalletStatus(event.destinationAccount);
    const result: AccountMergeResult = { ...empty, alerts: [], walletsMerged: [] };

    if (sourceStatus !== null) {
      const transition = nextWalletStatus(sourceStatus);
      if (transition.changed) {
        await this.store.markMerged(event.sourceAccount, {
          status: 'MERGED',
          mergedIntoAccount: event.destinationAccount,
          mergedAtLedger: event.ledgerSeq,
          sweptStroops: event.sweptStroops === null ? null : event.sweptStroops.toString(),
          mergeTransactionHash: event.transactionHash,
        });
        result.walletsMerged.push(event.sourceAccount);
        result.alerts.push(this.alert(event, 'SOURCE_DESTROYED', event.sourceAccount));
      }

      if (
        transition.changed &&
        this.options.autoTraceBeneficiary &&
        this.options.spawnTraceWatcher &&
        !(await this.store.isWatched(event.destinationAccount))
      ) {
        await this.options.spawnTraceWatcher(event.destinationAccount, event);
        result.tracedBeneficiary = event.destinationAccount;
      }
    }

    if (destinationStatus !== null) {
      result.alerts.push(this.alert(event, 'DESTINATION_RECEIVED', event.destinationAccount));
    }

    await this.store.markProcessed(event.operationId);
    return result;
  }

  private alert(event: AccountMergeEvent, role: MergeRole, monitoredAccount: string): AccountMergeAlert {
    return {
      type: role === 'SOURCE_DESTROYED' ? 'ACCOUNT_MERGED_AWAY' : 'ACCOUNT_MERGE_RECEIVED',
      severity: role === 'SOURCE_DESTROYED' ? 'CRITICAL' : 'INFO',
      role,
      monitoredAccount,
      sourceAccount: event.sourceAccount,
      destinationAccount: event.destinationAccount,
      sweptXlm: event.sweptXlm,
      sweptStroops: event.sweptStroops === null ? null : event.sweptStroops.toString(),
      ledgerSeq: event.ledgerSeq,
      transactionHash: event.transactionHash,
      operationId: event.operationId,
      occurredAt: event.occurredAt,
    };
  }
}

/** An in-memory store, for tests and for running without a database. */
export class InMemoryAccountMergeStore implements AccountMergeStore {
  readonly wallets = new Map<string, { status: WalletStatus; merged?: MergedWalletRecord }>();
  readonly processed = new Set<string>();
  readonly watched = new Set<string>();

  addWallet(accountId: string): void {
    this.wallets.set(accountId, { status: 'ACTIVE' });
    this.watched.add(accountId);
  }

  async getWalletStatus(accountId: string): Promise<WalletStatus | null> {
    return this.wallets.get(accountId)?.status ?? null;
  }

  async markMerged(accountId: string, record: MergedWalletRecord): Promise<void> {
    this.wallets.set(accountId, { status: 'MERGED', merged: record });
  }

  async hasProcessed(operationId: string): Promise<boolean> {
    return this.processed.has(operationId);
  }

  async markProcessed(operationId: string): Promise<void> {
    this.processed.add(operationId);
  }

  async isWatched(accountId: string): Promise<boolean> {
    return this.watched.has(accountId);
  }
}
