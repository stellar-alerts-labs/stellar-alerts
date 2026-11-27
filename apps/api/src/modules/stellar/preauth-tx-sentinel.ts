import * as StellarSdk from 'stellar-sdk';
import { createLogger } from '../../lib/logger';

const log = createLogger({ module: 'PreAuthTxSentinel' });

export function escapeTelegramHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char);
}

// ── Types & Domain Entities ──────────────────────────────────────────────────

export type PreAuthTxSignerStatus =
  | 'ACTIVE'
  | 'CONSUMED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'REMOVED';

export type PreAuthTxEventType =
  | 'PREAUTH_TX_SIGNER_ADDED'
  | 'PREAUTH_TX_SIGNER_REMOVED'
  | 'PREAUTH_TX_SEQUENCE_INVALIDATED'
  | 'PREAUTH_TX_EXPIRED'
  | 'PREAUTH_TX_EXECUTED_AND_CONSUMED';

export type PreAuthTxAlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface PreAuthTxTimeBounds {
  minTime: string;
  maxTime: string;
}

/**
 * Domain entity representing a Stellar Pre-Authorized Transaction signer (StrKey T...).
 * A pre-authorized transaction signer holds the SHA256 hash of a pre-signed transaction
 * as an authorized signer on an account.
 */
export interface PreAuthTxSigner {
  /** Account ID (G...) where this pre-authorized transaction signer is registered. */
  accountId: string;
  /** StrKey encoded pre-auth transaction hash (T...). */
  signerKey: string;
  /** Hex-encoded SHA-256 hash of the pre-authorized transaction (lowercase). */
  txHash: string;
  /** Signer weight on the account (> 0 means active, 0 means removed/consumed). */
  weight: number;
  /** Sequence number of the pre-authorized transaction if known. */
  sequenceNumber?: string | null;
  /** Time bounds (minTime, maxTime) in unix epoch seconds if defined. */
  timeBounds?: PreAuthTxTimeBounds | null;
  /** Current lifecycle status. */
  status: PreAuthTxSignerStatus;
  /** ISO timestamp when the signer was registered. */
  registeredAt: string;
  /** ISO timestamp when the transaction executed and was consumed. */
  consumedAt?: string;
  /** ISO timestamp when the pre-authorized transaction sequence was invalidated. */
  invalidatedAt?: string;
  /** ISO timestamp when the pre-authorized transaction expired. */
  expiredAt?: string;
  /** ISO timestamp when the signer was manually removed via set_options. */
  removedAt?: string;
  /** Optional metadata / context. */
  metadata?: Record<string, unknown>;
}

export interface PreAuthTxAlert {
  eventType: PreAuthTxEventType;
  severity: PreAuthTxAlertSeverity;
  account: string;
  signerKey: string;
  txHash: string;
  weight: number;
  sequenceNumber?: string | null;
  timeBounds?: PreAuthTxTimeBounds | null;
  operationId?: string;
  transactionHash?: string;
  occurredAt: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface HorizonOperationRecord {
  id?: string;
  paging_token?: string;
  type: string;
  created_at?: string;
  transaction_hash?: string;
  transaction_successful?: boolean;
  source_account?: string;
  signer_key?: string;
  signer_weight?: number | string;
  signer_type?: string;
  bump_to?: string;
  signer?: {
    key?: string;
    weight?: number | string;
    type?: string;
  };
  [key: string]: unknown;
}

export interface HorizonTransactionRecord {
  hash: string;
  successful?: boolean;
  source_account?: string;
  source_account_sequence?: string;
  created_at?: string;
  ledger_close_time?: string;
  envelope_xdr?: string;
  inner_transaction?: { hash?: string; max_fee?: string | number };
  fee_bump_transaction?: { hash?: string };
  [key: string]: unknown;
}

export interface RegisterPreAuthTxParams {
  accountId: string;
  signerKey?: string;
  txHash?: string;
  weight?: number;
  sequenceNumber?: string | null;
  timeBounds?: PreAuthTxTimeBounds | null;
  envelopeXdr?: string;
  networkPassphrase?: string;
  metadata?: Record<string, unknown>;
}

export interface DecodedPreAuthTxEnvelope {
  sourceAccount: string;
  txHash: string;
  signerKey: string;
  sequenceNumber: string;
  timeBounds: PreAuthTxTimeBounds | null;
  operationCount: number;
  isFeeBump: boolean;
}

export type PreAuthTxAlertHandler = (alert: PreAuthTxAlert) => void | Promise<void>;

export interface PreAuthTxSentinelConfig {
  /** Alert cooldown in ms to prevent duplicate spam. Default: 5 minutes. */
  alertCooldownMs?: number;
}

// ── StrKey & Envelope Helpers ────────────────────────────────────────────────

/**
 * Validates whether a given key is a Stellar PreAuthTx StrKey (56 characters starting with 'T').
 */
export function isPreAuthTxStrKey(key: string): boolean {
  if (typeof key !== 'string' || !key.startsWith('T') || key.length !== 56) {
    return false;
  }
  try {
    const decoded = StellarSdk.StrKey.decodePreAuthTx(key);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

/**
 * Converts a 32-byte transaction SHA256 hash (Buffer, Uint8Array, or hex string)
 * into a Stellar StrKey pre-authorized transaction key (starts with 'T').
 */
export function txHashToPreAuthTxKey(hash: Buffer | Uint8Array | string): string {
  const buf = typeof hash === 'string'
    ? Buffer.from(hash.replace(/^0x/, ''), 'hex')
    : Buffer.from(hash);
  if (buf.length !== 32) {
    throw new Error(`Expected 32-byte hash for pre-authorized transaction, received ${buf.length} bytes`);
  }
  return StellarSdk.StrKey.encodePreAuthTx(buf);
}

/**
 * Decodes a Stellar StrKey pre-authorized transaction key (starts with 'T')
 * into its 32-byte lowercase hex hash.
 */
export function preAuthTxKeyToHash(key: string): string {
  const buf = StellarSdk.StrKey.decodePreAuthTx(key);
  return Buffer.from(buf).toString('hex').toLowerCase();
}

/**
 * Decodes a raw transaction envelope XDR (base64) to extract source account,
 * transaction hash, derived T... pre-auth signer key, sequence number, and time bounds.
 */
export function decodePreAuthTxEnvelope(
  envelopeXdr: string,
  networkPassphrase: string = StellarSdk.Networks.PUBLIC,
): DecodedPreAuthTxEnvelope | null {
  try {
    const tx = StellarSdk.TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
    if ('innerTransaction' in tx) {
      const inner = tx.innerTransaction;
      const innerHash = inner.hash().toString('hex').toLowerCase();
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(inner.hash());
      const tb = inner.timeBounds
        ? { minTime: String(inner.timeBounds.minTime), maxTime: String(inner.timeBounds.maxTime) }
        : null;
      return {
        sourceAccount: inner.source,
        txHash: innerHash,
        signerKey,
        sequenceNumber: inner.sequence,
        timeBounds: tb,
        operationCount: inner.operations.length,
        isFeeBump: true,
      };
    } else {
      const hash = tx.hash().toString('hex').toLowerCase();
      const signerKey = StellarSdk.StrKey.encodePreAuthTx(tx.hash());
      const tb = tx.timeBounds
        ? { minTime: String(tx.timeBounds.minTime), maxTime: String(tx.timeBounds.maxTime) }
        : null;
      return {
        sourceAccount: tx.source,
        txHash: hash,
        signerKey,
        sequenceNumber: tx.sequence,
        timeBounds: tb,
        operationCount: tx.operations.length,
        isFeeBump: false,
      };
    }
  } catch {
    return null;
  }
}

function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;
}

// ── Persistence Seam (Store) ─────────────────────────────────────────────────

export interface PreAuthTxStore {
  get(accountId: string, signerKey: string): Promise<PreAuthTxSigner | null> | PreAuthTxSigner | null;
  getByAccount(accountId: string): Promise<PreAuthTxSigner[]> | PreAuthTxSigner[];
  getByTxHash(txHash: string): Promise<PreAuthTxSigner | null> | PreAuthTxSigner | null;
  getAllActive(): Promise<PreAuthTxSigner[]> | PreAuthTxSigner[];
  save(signer: PreAuthTxSigner): Promise<void> | void;
  delete(accountId: string, signerKey: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export class InMemoryPreAuthTxStore implements PreAuthTxStore {
  private readonly signers = new Map<string, PreAuthTxSigner>();

  private makeKey(accountId: string, signerKey: string): string {
    return `${accountId}:${signerKey}`;
  }

  get(accountId: string, signerKey: string): PreAuthTxSigner | null {
    return this.signers.get(this.makeKey(accountId, signerKey)) ?? null;
  }

  getByAccount(accountId: string): PreAuthTxSigner[] {
    const results: PreAuthTxSigner[] = [];
    for (const signer of this.signers.values()) {
      if (signer.accountId === accountId) {
        results.push(signer);
      }
    }
    return results;
  }

  getByTxHash(txHash: string): PreAuthTxSigner | null {
    const normalized = txHash.toLowerCase();
    for (const signer of this.signers.values()) {
      if (signer.txHash.toLowerCase() === normalized) {
        return signer;
      }
    }
    return null;
  }

  getAllActive(): PreAuthTxSigner[] {
    const results: PreAuthTxSigner[] = [];
    for (const signer of this.signers.values()) {
      if (signer.status === 'ACTIVE') {
        results.push(signer);
      }
    }
    return results;
  }

  save(signer: PreAuthTxSigner): void {
    this.signers.set(this.makeKey(signer.accountId, signer.signerKey), { ...signer });
  }

  delete(accountId: string, signerKey: string): void {
    this.signers.delete(this.makeKey(accountId, signerKey));
  }

  clear(): void {
    this.signers.clear();
  }
}

// ── Pre-Auth Tx Sentinel Core Engine ─────────────────────────────────────────

export class PreAuthTxSentinel {
  private readonly store: PreAuthTxStore;
  private readonly config: Required<PreAuthTxSentinelConfig>;
  private readonly handlers = new Set<PreAuthTxAlertHandler>();
  private readonly lastAlertTimestamp = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    store?: PreAuthTxStore,
    config: PreAuthTxSentinelConfig = {},
    now: () => number = Date.now,
  ) {
    this.store = store ?? new InMemoryPreAuthTxStore();
    this.config = {
      alertCooldownMs: config.alertCooldownMs ?? 5 * 60 * 1000,
    };
    this.now = now;
  }

  public subscribe(handler: PreAuthTxAlertHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private async dispatchAlert(alert: PreAuthTxAlert): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(alert);
      } catch (err: unknown) {
        log.warn(`PreAuthTxSentinel handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private shouldAlert(alertKey: string): boolean {
    const last = this.lastAlertTimestamp.get(alertKey);
    const currentTime = this.now();
    if (last !== undefined && currentTime - last < this.config.alertCooldownMs) {
      return false;
    }
    this.lastAlertTimestamp.set(alertKey, currentTime);
    return true;
  }

  /**
   * Registers or updates a tracked pre-authorized transaction signer.
   * Can accept either raw envelope XDR or pre-parsed properties.
   */
  public async registerPreAuthTx(params: RegisterPreAuthTxParams): Promise<PreAuthTxSigner> {
    let {
      accountId,
      signerKey,
      txHash,
      weight = 1,
      sequenceNumber,
      timeBounds,
      envelopeXdr,
      networkPassphrase,
      metadata,
    } = params;

    if (envelopeXdr) {
      const decoded = decodePreAuthTxEnvelope(envelopeXdr, networkPassphrase);
      if (decoded) {
        accountId = accountId || decoded.sourceAccount;
        txHash = txHash || decoded.txHash;
        signerKey = signerKey || decoded.signerKey;
        sequenceNumber = sequenceNumber || decoded.sequenceNumber;
        timeBounds = timeBounds || decoded.timeBounds;
      }
    }

    if (!signerKey && txHash) {
      signerKey = txHashToPreAuthTxKey(txHash);
    } else if (signerKey && !txHash && isPreAuthTxStrKey(signerKey)) {
      txHash = preAuthTxKeyToHash(signerKey);
    }

    if (!signerKey || !txHash) {
      throw new Error('Either signerKey (T...) or txHash must be provided or derived from envelope');
    }

    const existing = await this.store.get(accountId, signerKey);
    const updated: PreAuthTxSigner = {
      accountId,
      signerKey,
      txHash: txHash.toLowerCase(),
      weight: weight > 0 ? weight : (existing?.weight ?? 1),
      sequenceNumber: sequenceNumber ?? existing?.sequenceNumber ?? null,
      timeBounds: timeBounds ?? existing?.timeBounds ?? null,
      status: 'ACTIVE',
      registeredAt: existing?.registeredAt ?? new Date(this.now()).toISOString(),
      metadata: { ...existing?.metadata, ...metadata },
    };

    await this.store.save(updated);
    return updated;
  }

  /**
   * Evaluates a Stellar operation record (e.g. from Horizon or streaming ingest).
   * Detects:
   * 1. `set_options` adding a SIGNER_KEY_TYPE_PRE_AUTH_TX (weight > 0).
   * 2. `set_options` removing a SIGNER_KEY_TYPE_PRE_AUTH_TX (weight = 0).
   * 3. `bump_sequence` operations that jump past an active pre-auth tx's sequence number.
   */
  public async processOperation(op: HorizonOperationRecord): Promise<PreAuthTxAlert | null> {
    if (op.transaction_successful === false) {
      return null;
    }

    // ── Handle set_options operations ────────────────────────────────────────
    if (op.type === 'set_options') {
      const signerKey = op.signer_key ?? op.signer?.key;
      const rawWeight = op.signer_weight !== undefined ? op.signer_weight : op.signer?.weight;
      const weight = rawWeight !== undefined ? Number(rawWeight) : undefined;
      const signerType = (op.signer_type ?? op.signer?.type ?? '').toLowerCase();

      const isPreAuth =
        (signerKey && isPreAuthTxStrKey(signerKey)) ||
        signerType === 'preauthtx' ||
        signerType === 'pre_auth_tx' ||
        signerType === 'signer_key_type_pre_auth_tx' ||
        signerType === 'signerkeytypepreauthtx';

      if (!isPreAuth || !signerKey) {
        return null;
      }

      const accountId = op.source_account;
      if (!accountId) {
        return null;
      }

      const txHash = isPreAuthTxStrKey(signerKey)
        ? preAuthTxKeyToHash(signerKey)
        : signerKey.toLowerCase();

      const existing = await this.store.get(accountId, signerKey);

      // 1. Pre-Auth Signer Added (weight > 0)
      if (weight !== undefined && weight > 0) {
        const dedupeKey = `added:${accountId}:${signerKey}`;
        if (!this.shouldAlert(dedupeKey)) {
          return null;
        }

        const newRecord: PreAuthTxSigner = {
          accountId,
          signerKey,
          txHash,
          weight,
          sequenceNumber: existing?.sequenceNumber ?? null,
          timeBounds: existing?.timeBounds ?? null,
          status: 'ACTIVE',
          registeredAt: op.created_at ?? new Date(this.now()).toISOString(),
          metadata: existing?.metadata,
        };
        await this.store.save(newRecord);

        const alert: PreAuthTxAlert = {
          eventType: 'PREAUTH_TX_SIGNER_ADDED',
          severity: 'INFO',
          account: accountId,
          signerKey,
          txHash,
          weight,
          sequenceNumber: newRecord.sequenceNumber,
          timeBounds: newRecord.timeBounds,
          operationId: op.id,
          transactionHash: op.transaction_hash,
          occurredAt: op.created_at ?? new Date(this.now()).toISOString(),
          message:
            `Pre-authorized transaction signer ${shortKey(signerKey)} added to account ` +
            `${shortKey(accountId)} with weight ${weight}.`,
          details: { weight, signerType },
        };

        await this.dispatchAlert(alert);
        return alert;
      }

      // 2. Pre-Auth Signer Removed (weight === 0)
      if (weight === 0) {
        // If the signer was already consumed by an execution, the 0-weight is the
        // protocol's automatic removal; do not emit a manual removal warning.
        if (existing?.status === 'CONSUMED') {
          return null;
        }

        const dedupeKey = `removed:${accountId}:${signerKey}`;
        if (!this.shouldAlert(dedupeKey)) {
          return null;
        }

        if (existing) {
          existing.status = 'REMOVED';
          existing.weight = 0;
          existing.removedAt = op.created_at ?? new Date(this.now()).toISOString();
          await this.store.save(existing);
        }

        const alert: PreAuthTxAlert = {
          eventType: 'PREAUTH_TX_SIGNER_REMOVED',
          severity: 'WARNING',
          account: accountId,
          signerKey,
          txHash,
          weight: 0,
          sequenceNumber: existing?.sequenceNumber ?? null,
          timeBounds: existing?.timeBounds ?? null,
          operationId: op.id,
          transactionHash: op.transaction_hash,
          occurredAt: op.created_at ?? new Date(this.now()).toISOString(),
          message:
            `Pre-authorized transaction signer ${shortKey(signerKey)} manually removed ` +
            `(weight set to 0) from account ${shortKey(accountId)}.`,
          details: { previousStatus: existing?.status ?? 'UNKNOWN' },
        };

        await this.dispatchAlert(alert);
        return alert;
      }
    }

    // ── Handle bump_sequence operations ──────────────────────────────────────
    if (op.type === 'bump_sequence' && op.bump_to && op.source_account) {
      const accountId = op.source_account;
      const bumpTo = BigInt(op.bump_to);
      const signers = await this.store.getByAccount(accountId);

      for (const signer of signers) {
        if (signer.status === 'ACTIVE' && signer.sequenceNumber) {
          const targetSeq = BigInt(signer.sequenceNumber);
          if (bumpTo >= targetSeq) {
            signer.status = 'INVALIDATED';
            signer.invalidatedAt = op.created_at ?? new Date(this.now()).toISOString();
            await this.store.save(signer);

            const alert: PreAuthTxAlert = {
              eventType: 'PREAUTH_TX_SEQUENCE_INVALIDATED',
              severity: 'CRITICAL',
              account: accountId,
              signerKey: signer.signerKey,
              txHash: signer.txHash,
              weight: signer.weight,
              sequenceNumber: signer.sequenceNumber,
              timeBounds: signer.timeBounds,
              operationId: op.id,
              transactionHash: op.transaction_hash,
              occurredAt: op.created_at ?? new Date(this.now()).toISOString(),
              message:
                `CRITICAL: Pre-authorized transaction ${shortKey(signer.txHash)} sequence (${signer.sequenceNumber}) ` +
                `invalidated! Account sequence bumped to ${bumpTo} by operation ${op.id ?? '(unknown)'}.`,
              details: {
                bumpTo: String(bumpTo),
                invalidatedSeq: signer.sequenceNumber,
                reason: 'BUMP_SEQUENCE_OPERATION',
              },
            };

            await this.dispatchAlert(alert);
            return alert;
          }
        }
      }
    }

    return null;
  }

  /**
   * Evaluates a completed Horizon transaction record.
   * Detects:
   * 1. Automatic Consumption: The transaction matches an active pre-auth tx hash,
   *    meaning it executed on-chain and Stellar Core consumed the signer.
   * 2. Sequence Invalidation Guard: Another transaction on the same source account
   *    executed with a sequence number >= the pre-auth transaction's sequence number,
   *    permanently invalidating the pre-authorized transaction.
   */
  public async processTransaction(tx: HorizonTransactionRecord): Promise<PreAuthTxAlert[]> {
    if (tx.successful === false) {
      return [];
    }

    const alerts: PreAuthTxAlert[] = [];
    const txHash = tx.hash.toLowerCase();
    const innerHash = tx.inner_transaction?.hash?.toLowerCase();

    // ── 1. Automatic Consumption Detection ───────────────────────────────────
    const executedMatch =
      (await this.store.getByTxHash(txHash)) ||
      (innerHash ? await this.store.getByTxHash(innerHash) : null);

    if (executedMatch && executedMatch.status === 'ACTIVE') {
      executedMatch.status = 'CONSUMED';
      executedMatch.weight = 0;
      executedMatch.consumedAt = tx.created_at ?? new Date(this.now()).toISOString();
      await this.store.save(executedMatch);

      const dedupeKey = `consumed:${executedMatch.accountId}:${executedMatch.signerKey}`;
      if (this.shouldAlert(dedupeKey)) {
        const alert: PreAuthTxAlert = {
          eventType: 'PREAUTH_TX_EXECUTED_AND_CONSUMED',
          severity: 'INFO',
          account: executedMatch.accountId,
          signerKey: executedMatch.signerKey,
          txHash: executedMatch.txHash,
          weight: 0,
          sequenceNumber: executedMatch.sequenceNumber,
          timeBounds: executedMatch.timeBounds,
          transactionHash: tx.hash,
          occurredAt: tx.created_at ?? new Date(this.now()).toISOString(),
          message:
            `Pre-authorized transaction ${shortKey(executedMatch.txHash)} executed successfully ` +
            `and was automatically consumed by the Stellar protocol.`,
          details: {
            innerTxHash: innerHash,
            sequenceNumber: executedMatch.sequenceNumber,
          },
        };
        alerts.push(alert);
        await this.dispatchAlert(alert);
      }
    }

    // ── 2. Sequence Number Invalidation Guard ─────────────────────────────────
    if (tx.source_account && tx.source_account_sequence) {
      const accountId = tx.source_account;
      const txSeq = BigInt(tx.source_account_sequence);
      const activeSigners = await this.store.getByAccount(accountId);

      for (const signer of activeSigners) {
        if (signer.status !== 'ACTIVE' || !signer.sequenceNumber) {
          continue;
        }

        // Skip if this transaction was the pre-authorized transaction itself
        const isSelf =
          signer.txHash.toLowerCase() === txHash ||
          (innerHash && signer.txHash.toLowerCase() === innerHash);
        if (isSelf) {
          continue;
        }

        const preAuthSeq = BigInt(signer.sequenceNumber);

        // If the account's executed transaction sequence is >= the pre-auth transaction's sequence,
        // the pre-auth transaction can never be submitted to Stellar Core without a txBAD_SEQ error.
        if (txSeq >= preAuthSeq) {
          signer.status = 'INVALIDATED';
          signer.invalidatedAt = tx.created_at ?? new Date(this.now()).toISOString();
          await this.store.save(signer);

          const dedupeKey = `invalidated:${signer.accountId}:${signer.signerKey}`;
          if (this.shouldAlert(dedupeKey)) {
            const alert: PreAuthTxAlert = {
              eventType: 'PREAUTH_TX_SEQUENCE_INVALIDATED',
              severity: 'CRITICAL',
              account: signer.accountId,
              signerKey: signer.signerKey,
              txHash: signer.txHash,
              weight: signer.weight,
              sequenceNumber: signer.sequenceNumber,
              timeBounds: signer.timeBounds,
              transactionHash: tx.hash,
              occurredAt: tx.created_at ?? new Date(this.now()).toISOString(),
              message:
                `CRITICAL: Pre-authorized transaction ${shortKey(signer.txHash)} sequence (${signer.sequenceNumber}) ` +
                `invalidated! Account ${shortKey(signer.accountId)} sequence advanced to ${txSeq} ` +
                `by transaction ${shortKey(tx.hash)}.`,
              details: {
                invalidatingTxHash: tx.hash,
                accountSequenceAfterTx: String(txSeq),
                requiredSequence: signer.sequenceNumber,
              },
            };
            alerts.push(alert);
            await this.dispatchAlert(alert);
          }
        }
      }
    }

    return alerts;
  }

  /**
   * Expiration Monitor:
   * Scans all active pre-authorized transactions and verifies whether the current
   * time (or ledger close time in seconds) has exceeded `timeBounds.maxTime`.
   * Stellar protocol rejects transactions with max_time < ledger close time,
   * so an unsubmitted pre-auth transaction whose max_time has passed is permanently expired.
   */
  public async checkExpirations(currentTimeOrLedgerCloseTimeSeconds?: number): Promise<PreAuthTxAlert[]> {
    const activeSigners = await this.store.getAllActive();
    const currentSeconds = currentTimeOrLedgerCloseTimeSeconds ?? Math.floor(this.now() / 1000);
    const alerts: PreAuthTxAlert[] = [];

    for (const signer of activeSigners) {
      if (signer.status !== 'ACTIVE' || !signer.timeBounds?.maxTime) {
        continue;
      }

      const maxTime = Number(signer.timeBounds.maxTime);
      // maxTime === 0 denotes unbounded max time in Stellar
      if (maxTime > 0 && currentSeconds > maxTime) {
        signer.status = 'EXPIRED';
        signer.expiredAt = new Date(currentSeconds * 1000).toISOString();
        await this.store.save(signer);

        const dedupeKey = `expired:${signer.accountId}:${signer.signerKey}`;
        if (this.shouldAlert(dedupeKey)) {
          const alert: PreAuthTxAlert = {
            eventType: 'PREAUTH_TX_EXPIRED',
            severity: 'CRITICAL',
            account: signer.accountId,
            signerKey: signer.signerKey,
            txHash: signer.txHash,
            weight: signer.weight,
            sequenceNumber: signer.sequenceNumber,
            timeBounds: signer.timeBounds,
            occurredAt: new Date(currentSeconds * 1000).toISOString(),
            message:
              `CRITICAL: Pre-authorized transaction ${shortKey(signer.txHash)} has EXPIRED! ` +
              `Time window closed at ${new Date(maxTime * 1000).toISOString()} (max_time: ${maxTime}) ` +
              `without on-chain execution.`,
            details: {
              maxTime: String(maxTime),
              minTime: signer.timeBounds.minTime,
              currentLedgerTime: currentSeconds,
            },
          };
          alerts.push(alert);
          await this.dispatchAlert(alert);
        }
      }
    }

    return alerts;
  }

  /**
   * Batch processes a ledger's operations, transactions, and close time in strict order.
   */
  public async processLedger(
    ledgerCloseTimeSeconds: number,
    transactions: HorizonTransactionRecord[] = [],
    operations: HorizonOperationRecord[] = [],
  ): Promise<PreAuthTxAlert[]> {
    const alerts: PreAuthTxAlert[] = [];

    // 1. Ingest operations (signers added / removed / sequence bumps)
    for (const op of operations) {
      const alert = await this.processOperation(op);
      if (alert) alerts.push(alert);
    }

    // 2. Ingest transactions (consumption & sequence invalidations)
    for (const tx of transactions) {
      const txAlerts = await this.processTransaction(tx);
      alerts.push(...txAlerts);
    }

    // 3. Evaluate time bound expirations against ledger close time
    const expirationAlerts = await this.checkExpirations(ledgerCloseTimeSeconds);
    alerts.push(...expirationAlerts);

    return alerts;
  }

  /**
   * Retrieves a single tracked pre-authorized transaction by account and signer key or tx hash.
   */
  public async getPreAuthTx(accountId: string, signerKeyOrTxHash: string): Promise<PreAuthTxSigner | null> {
    const byKey = await this.store.get(accountId, signerKeyOrTxHash);
    if (byKey) return byKey;
    return this.store.getByTxHash(signerKeyOrTxHash);
  }

  /**
   * Retrieves all pre-authorized transactions, optionally filtered by account.
   */
  public async getPreAuthTxs(accountId?: string): Promise<PreAuthTxSigner[]> {
    if (accountId) {
      return this.store.getByAccount(accountId);
    }
    return this.store.getAllActive();
  }

  public clear(): void {
    this.store.clear();
    this.handlers.clear();
    this.lastAlertTimestamp.clear();
  }
}

// ── Webhook & Notification Adapters ──────────────────────────────────────────

export function formatPreAuthTxTelegramHtml(alert: PreAuthTxAlert): string {
  const shortAcc = shortKey(alert.account);
  const shortSigner = shortKey(alert.signerKey);
  const shortTx = shortKey(alert.txHash);

  const lines = [
    `<b>[${escapeTelegramHtml(alert.severity)}] Stellar Pre-Auth Transaction Sentinel</b>`,
    `<b>Event:</b> <code>${escapeTelegramHtml(alert.eventType)}</code>`,
    `<b>Account:</b> <code>${escapeTelegramHtml(shortAcc)}</code>`,
    `<b>Signer Key:</b> <code>${escapeTelegramHtml(shortSigner)}</code>`,
    `<b>Pre-Auth Tx Hash:</b> <code>${escapeTelegramHtml(shortTx)}</code>`,
    alert.sequenceNumber ? `<b>Sequence:</b> <code>${escapeTelegramHtml(alert.sequenceNumber)}</code>` : '',
    alert.timeBounds
      ? `<b>Time Bounds:</b> [${escapeTelegramHtml(alert.timeBounds.minTime)}, ${escapeTelegramHtml(alert.timeBounds.maxTime)}]`
      : '',
    `<b>Message:</b> ${escapeTelegramHtml(alert.message)}`,
    `<i>Detected at ${escapeTelegramHtml(alert.occurredAt)}</i>`,
  ];

  return lines.filter(Boolean).join('\n');
}

export function formatPreAuthTxWebhookPayload(alert: PreAuthTxAlert): Record<string, unknown> {
  return {
    event: 'stellar.preauth_tx.alert',
    eventType: alert.eventType,
    severity: alert.severity,
    account: alert.account,
    signerKey: alert.signerKey,
    txHash: alert.txHash,
    weight: alert.weight,
    sequenceNumber: alert.sequenceNumber ?? null,
    timeBounds: alert.timeBounds ?? null,
    operationId: alert.operationId ?? null,
    transactionHash: alert.transactionHash ?? null,
    message: alert.message,
    occurredAt: alert.occurredAt,
    details: alert.details ?? {},
  };
}

export type PreAuthTxNotifier = (
  userId: string,
  payload: Record<string, unknown>,
  telegramHtml: string,
) => Promise<void> | void;

/**
 * Adapter that delivers a PreAuthTxAlert to a registered user via webhooks and Telegram.
 */
export async function deliverPreAuthTxAlert(
  alert: PreAuthTxAlert,
  userId?: string,
  notifier?: PreAuthTxNotifier,
): Promise<void> {
  const payload = formatPreAuthTxWebhookPayload(alert);
  const html = formatPreAuthTxTelegramHtml(alert);

  if (userId) {
    try {
      if (notifier) {
        await notifier(userId, payload, html);
      } else {
        const { deliverUserAlert } = await import('./alert-delivery');
        await deliverUserAlert(userId, payload, html);
      }
    } catch (err: unknown) {
      log.warn(`Delivery failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const preAuthTxSentinel = new PreAuthTxSentinel();
