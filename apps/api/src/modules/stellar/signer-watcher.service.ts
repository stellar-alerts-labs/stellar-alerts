/**
 * SignerWatcher — multi-signer threshold mutation & master-key removal sentinel.
 *
 * An unauthorized `set_options` transaction that removes a signer, lowers a
 * threshold, or zeroes the master key weight is the signature of an account
 * takeover. Horizon's per-account payments stream never surfaces `set_options`
 * operations, so instead of parsing operations the watcher compares the
 * account's signer/threshold state *before* (last stored baseline) and *after*
 * (freshly loaded from Horizon) and emits a finding for every difference.
 *
 * The diffing is pure (`diffSignerState`) so it is unit-testable without any
 * network or storage; `SignerWatcher` adds baseline storage + notification.
 */
import { createLogger } from '../../lib/logger';

const log = createLogger({ module: 'SignerWatcher' });

export interface SignerEntry {
  key: string;
  weight: number;
}

export interface ThresholdSet {
  low: number;
  medium: number;
  high: number;
}

/** Account authorization state captured at a point in time. */
export interface SignerSnapshot {
  accountId: string;
  signers: SignerEntry[];
  thresholds: ThresholdSet;
  /** Weight of the account's own key (0 when the master key is disabled/removed). */
  masterWeight: number;
  capturedAt: string;
}

export type SignerFindingType =
  | 'signer_added'
  | 'signer_removed'
  | 'signer_weight_changed'
  | 'threshold_changed'
  | 'master_key_disabled'
  | 'master_weight_changed'
  | 'account_lockout_risk';

export type SignerFindingSeverity = 'warning' | 'critical';

export type ThresholdLevel = keyof ThresholdSet;

export interface SignerFinding {
  type: SignerFindingType;
  severity: SignerFindingSeverity;
  accountId: string;
  summary: string;
  signerKey?: string;
  thresholdLevel?: ThresholdLevel;
  previousValue?: number;
  currentValue?: number;
  detectedAt: string;
}

/** Minimal shape of Horizon's account response that this module relies on. */
export interface SignerAccountState {
  signers: SignerEntry[];
  thresholds: ThresholdSet;
  masterWeight: number;
}

export type SignerAccountFetcher = (accountId: string) => Promise<SignerAccountState | null>;

export type SignerNotifier = (accountId: string, findings: SignerFinding[]) => Promise<void> | void;

/** Persistence seam for baselines so restarts don't blind the watcher. */
export interface SignerSnapshotStore {
  get(accountId: string): Promise<SignerSnapshot | null>;
  set(snapshot: SignerSnapshot): Promise<void>;
  delete?(accountId: string): Promise<void>;
}

export class InMemorySignerSnapshotStore implements SignerSnapshotStore {
  private readonly snapshots = new Map<string, SignerSnapshot>();

  async get(accountId: string): Promise<SignerSnapshot | null> {
    return this.snapshots.get(accountId) ?? null;
  }

  async set(snapshot: SignerSnapshot): Promise<void> {
    this.snapshots.set(snapshot.accountId, snapshot);
  }

  async delete(accountId: string): Promise<void> {
    this.snapshots.delete(accountId);
  }
}

/** Subset of ioredis used for snapshot persistence. */
export interface SignerRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del?(key: string): Promise<unknown>;
}

export class RedisSignerSnapshotStore implements SignerSnapshotStore {
  constructor(
    private readonly redis: SignerRedisLike,
    private readonly keyPrefix = 'signer-watcher:snapshot:',
  ) {}

  async get(accountId: string): Promise<SignerSnapshot | null> {
    const raw = await this.redis.get(this.keyPrefix + accountId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SignerSnapshot;
    } catch {
      // A corrupt baseline is treated as "no baseline" so the next pass re-seeds it.
      return null;
    }
  }

  async set(snapshot: SignerSnapshot): Promise<void> {
    await this.redis.set(this.keyPrefix + snapshot.accountId, JSON.stringify(snapshot));
  }

  async delete(accountId: string): Promise<void> {
    await this.redis.del?.(this.keyPrefix + accountId);
  }
}

const THRESHOLD_LEVELS: ThresholdLevel[] = ['low', 'medium', 'high'];

function short(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;
}

/** Builds a snapshot, normalising weights and ordering signers for stable comparison. */
export function buildSnapshot(
  accountId: string,
  state: SignerAccountState,
  now: Date = new Date(),
): SignerSnapshot {
  return {
    accountId,
    signers: state.signers
      .map((s) => ({ key: s.key, weight: Number(s.weight) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    thresholds: {
      low: Number(state.thresholds.low),
      medium: Number(state.thresholds.medium),
      high: Number(state.thresholds.high),
    },
    masterWeight: Number(state.masterWeight),
    capturedAt: now.toISOString(),
  };
}

function totalWeight(snapshot: SignerSnapshot): number {
  return snapshot.signers.reduce((sum, s) => sum + s.weight, 0);
}

/**
 * Compares the account state before and after a `set_options` change.
 *
 * Severity rules:
 *  - master key weight dropping to 0, or any signer removal, is `critical`
 *    (the takeover signature);
 *  - a threshold *decrease* is `critical` (weakens the multisig), an increase
 *    is a `warning`;
 *  - additions and other weight changes are `warning` unless they leave the
 *    account unable to meet its own high threshold (`account_lockout_risk`).
 */
export function diffSignerState(
  before: SignerSnapshot,
  after: SignerSnapshot,
  now: Date = new Date(),
): SignerFinding[] {
  const accountId = after.accountId;
  const detectedAt = now.toISOString();
  const findings: SignerFinding[] = [];

  const beforeByKey = new Map(before.signers.map((s) => [s.key, s.weight]));
  const afterByKey = new Map(after.signers.map((s) => [s.key, s.weight]));

  for (const [key, weight] of afterByKey) {
    if (key === accountId) continue; // master key handled separately below
    if (!beforeByKey.has(key)) {
      findings.push({
        type: 'signer_added',
        severity: 'warning',
        accountId,
        signerKey: key,
        currentValue: weight,
        summary: `Signer ${short(key)} added to ${short(accountId)} with weight ${weight}`,
        detectedAt,
      });
    } else if (beforeByKey.get(key) !== weight) {
      const previous = beforeByKey.get(key)!;
      findings.push({
        type: 'signer_weight_changed',
        severity: 'warning',
        accountId,
        signerKey: key,
        previousValue: previous,
        currentValue: weight,
        summary: `Signer ${short(key)} weight on ${short(accountId)} changed from ${previous} to ${weight}`,
        detectedAt,
      });
    }
  }

  for (const [key, weight] of beforeByKey) {
    if (key === accountId) continue;
    if (!afterByKey.has(key)) {
      findings.push({
        type: 'signer_removed',
        severity: 'critical',
        accountId,
        signerKey: key,
        previousValue: weight,
        summary: `Signer ${short(key)} (weight ${weight}) removed from ${short(accountId)}`,
        detectedAt,
      });
    }
  }

  if (before.masterWeight !== after.masterWeight) {
    if (after.masterWeight === 0 && before.masterWeight > 0) {
      findings.push({
        type: 'master_key_disabled',
        severity: 'critical',
        accountId,
        signerKey: accountId,
        previousValue: before.masterWeight,
        currentValue: 0,
        summary: `Master key of ${short(accountId)} zeroed (weight ${before.masterWeight} → 0) — possible account takeover`,
        detectedAt,
      });
    } else {
      findings.push({
        type: 'master_weight_changed',
        severity: after.masterWeight < before.masterWeight ? 'critical' : 'warning',
        accountId,
        signerKey: accountId,
        previousValue: before.masterWeight,
        currentValue: after.masterWeight,
        summary: `Master key weight of ${short(accountId)} changed from ${before.masterWeight} to ${after.masterWeight}`,
        detectedAt,
      });
    }
  }

  for (const level of THRESHOLD_LEVELS) {
    const previous = before.thresholds[level];
    const current = after.thresholds[level];
    if (previous !== current) {
      findings.push({
        type: 'threshold_changed',
        severity: current < previous ? 'critical' : 'warning',
        accountId,
        thresholdLevel: level,
        previousValue: previous,
        currentValue: current,
        summary: `${level} threshold on ${short(accountId)} changed from ${previous} to ${current}`,
        detectedAt,
      });
    }
  }

  // Lockout: the remaining weight (master + other signers) can no longer meet
  // the high threshold, so account-level changes become impossible. Only
  // flagged when the signer config actually changed in this diff, otherwise a
  // pre-existing misconfiguration would re-alert on every unrelated change.
  const changed = findings.length > 0;
  const afterTotal = totalWeight(after) + (afterByKey.has(accountId) ? 0 : after.masterWeight);
  if (changed && after.thresholds.high > 0 && afterTotal < after.thresholds.high) {
    findings.push({
      type: 'account_lockout_risk',
      severity: 'critical',
      accountId,
      thresholdLevel: 'high',
      previousValue: after.thresholds.high,
      currentValue: afterTotal,
      summary: `Total signing weight ${afterTotal} on ${short(accountId)} is below the high threshold ${after.thresholds.high}; the account can no longer change its own signers`,
      detectedAt,
    });
  }

  return findings;
}

export const defaultSignerNotifier: SignerNotifier = (accountId, findings) => {
  for (const finding of findings) {
    const level = finding.severity === 'critical' ? 'error' : 'warn';
    log[level]({ accountId, finding }, `🚨 [SignerWatcher] ${finding.summary}`);
  }
};

export interface SignerWatcherOptions {
  fetchAccount?: SignerAccountFetcher;
  store?: SignerSnapshotStore;
  notifier?: SignerNotifier;
  now?: () => Date;
}

export interface SignerCheckResult {
  accountId: string;
  /** `seeded` = first observation (baseline stored, nothing to compare); `skipped` = account could not be loaded. */
  status: 'seeded' | 'unchanged' | 'changed' | 'skipped';
  findings: SignerFinding[];
}

export class SignerWatcher {
  private readonly fetchAccount: SignerAccountFetcher;
  private readonly store: SignerSnapshotStore;
  private readonly notifier: SignerNotifier;
  private readonly now: () => Date;

  constructor(options: SignerWatcherOptions = {}) {
    this.fetchAccount = options.fetchAccount ?? defaultFetchAccount;
    this.store = options.store ?? new InMemorySignerSnapshotStore();
    this.notifier = options.notifier ?? defaultSignerNotifier;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Loads the account's current (post-operation) state, diffs it against the
   * stored baseline and notifies on any difference. The baseline is advanced
   * only after notification succeeds, so a failed notifier retries next pass
   * instead of silently swallowing a takeover.
   */
  async checkAccount(accountId: string): Promise<SignerCheckResult> {
    const state = await this.fetchAccount(accountId);
    if (!state) return { accountId, status: 'skipped', findings: [] };

    const after = buildSnapshot(accountId, state, this.now());
    const before = await this.store.get(accountId);

    if (!before) {
      await this.store.set(after);
      return { accountId, status: 'seeded', findings: [] };
    }

    const findings = diffSignerState(before, after, this.now());
    if (findings.length === 0) return { accountId, status: 'unchanged', findings };

    await this.notifier(accountId, findings);
    await this.store.set(after);
    return { accountId, status: 'changed', findings };
  }

  /** Checks many accounts, isolating failures so one bad account never blocks the rest. */
  async checkAccounts(accountIds: string[]): Promise<SignerCheckResult[]> {
    const results: SignerCheckResult[] = [];
    for (const accountId of accountIds) {
      try {
        results.push(await this.checkAccount(accountId));
      } catch (err) {
        log.warn({ accountId, err: err instanceof Error ? err.message : String(err) }, 'Signer check failed');
        results.push({ accountId, status: 'skipped', findings: [] });
      }
    }
    return results;
  }
}

async function defaultFetchAccount(accountId: string): Promise<SignerAccountState | null> {
  // Lazy import keeps this module (and its pure diffing) free of Horizon/env setup until used.
  const { stellar } = await import('../../lib/stellar');
  return stellar.getAccountSigners(accountId);
}

export const signerWatcher = new SignerWatcher();
