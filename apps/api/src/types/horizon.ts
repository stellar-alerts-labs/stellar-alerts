/**
 * Typed contracts for Horizon payment operation records returned by the
 * Stellar SDK's `.payments().forAccount().call()` / `.stream()` APIs.
 *
 * The Horizon "payments" endpoint returns a heterogeneous set of operation
 * types — `payment`, `create_account`, and Soroban Asset Contract (SAC)
 * invoke_host_function events that encode ERC-20-style transfers.  Previously
 * these were typed as `any` throughout the watcher worker, hiding bugs at
 * the ingestion boundary.  This module defines a discriminated union that
 * narrows each variant to only the fields it can carry, plus adapter
 * functions that extract the paging token / transaction hash from any variant
 * without unsafe casting.
 */

// ── Base fields present on every Horizon operation record ─────────────────

export interface HorizonOperationBase {
  /** Unique, monotonically increasing cursor token — encodes ledger+tx+op. */
  paging_token: string;
  /** ISO-8601 timestamp when the operation was included in the ledger. */
  created_at: string;
  /** Hash of the transaction that contains this operation. */
  transaction_hash: string;
  /** Hash alias — some SDK versions surface `hash` instead of `transaction_hash`. */
  hash?: string;
}

// ── Native / credit-alphanum payment ──────────────────────────────────────

export interface HorizonPaymentRecord extends HorizonOperationBase {
  type: 'payment';
  /** Decimal string amount (e.g. "10.5000000"). */
  amount: string;
  /** "native" | "credit_alphanum4" | "credit_alphanum12" */
  asset_type: string;
  /** Undefined for native (XLM) payments. */
  asset_code?: string;
  asset_issuer?: string;
  /** Sender's public key. */
  from: string;
  /** Receiver's public key. */
  to: string;
  /** Transaction memo (text memos only; binary memos are omitted). */
  memo?: string;
}

// ── create_account (funded from funder -> new account) ─────────────────────

export interface HorizonCreateAccountRecord extends HorizonOperationBase {
  type: 'create_account';
  /** XLM amount used to fund the new account. */
  starting_balance: string;
  /** Public key that funded the new account. */
  funder: string;
  /** Newly created account's public key. */
  account: string;
}

// ── Soroban Asset Contract invoke_host_function (SAC transfer) ────────────
//
// SAC transfers arrive via Horizon's "payments" endpoint as
// `invoke_host_function` operations whose body encodes a token-contract
// `transfer(from, to, amount)` call.  The fields below are what the
// Stellar SDK / Horizon surfaces directly on the record object; the
// parseSacTransferEvent() function in lib/stellar.ts handles the deeper
// ScVal decoding when a richer `topic` / `value` shape is present.

export interface HorizonSacTransferRecord extends HorizonOperationBase {
  type: 'invoke_host_function' | string; // SAC events are invoke_host_function
  /** Soroban topic array — present on RPC-derived records. */
  topic?: unknown[];
  /** Soroban event value / data. */
  value?: unknown;
  data?: unknown;
  /** Contract address, when present on the record. */
  contractId?: string;
  /** Asset metadata resolved by some indexers. */
  assetCode?: string;
  assetIssuer?: string | null;
  /** Ledger sequence where the event was emitted. */
  ledgerSeq?: number;
  /** May be present if the indexer already decoded the event. */
  from?: string;
  to?: string;
  amount?: string;
}

// ── Discriminated union ────────────────────────────────────────────────────

/**
 * Union of all operation-record shapes that can arrive from
 * `stellar.getPaymentsSince()` / `stellar.getRecentPayments()` and the
 * Horizon SSE stream.
 */
export type HorizonOperationRecord =
  | HorizonPaymentRecord
  | HorizonCreateAccountRecord
  | HorizonSacTransferRecord;

export function isHorizonOperationRecord(
  value: unknown,
): value is HorizonOperationRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : null;
  if (!type) {
    return false;
  }

  const hasBaseFields =
    typeof record.paging_token === 'string' &&
    typeof record.created_at === 'string' &&
    (typeof record.transaction_hash === 'string' || typeof record.hash === 'string');

  if (!hasBaseFields) {
    return false;
  }

  if (type === 'payment') {
    return (
      typeof record.amount === 'string' &&
      typeof record.from === 'string' &&
      typeof record.to === 'string'
    );
  }

  if (type === 'create_account') {
    return (
      typeof record.starting_balance === 'string' &&
      typeof record.funder === 'string' &&
      typeof record.account === 'string'
    );
  }

  return true;
}

export function asHorizonOperationRecords(value: unknown): HorizonOperationRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isHorizonOperationRecord);
}

// ── Type guards ────────────────────────────────────────────────────────────

export function isHorizonPayment(
  record: HorizonOperationRecord,
): record is HorizonPaymentRecord {
  return record.type === 'payment';
}

export function isHorizonCreateAccount(
  record: HorizonOperationRecord,
): record is HorizonCreateAccountRecord {
  return record.type === 'create_account';
}

// ── Adapter helpers ────────────────────────────────────────────────────────

/**
 * Returns the paging token from any Horizon operation record.
 * Some SDK versions only surface `paging_token`; others also
 * provide a top-level `id` field — this function prefers
 * `paging_token` and is the single authoritative extractor.
 */
export function getHorizonPagingToken(
  record: HorizonOperationRecord,
): string | undefined {
  return record.paging_token || undefined;
}

/**
 * Returns the transaction hash from any Horizon operation record,
 * normalising across the `transaction_hash` / `hash` alias that
 * different SDK versions emit.
 */
export function getHorizonTxHash(record: HorizonOperationRecord): string {
  return record.transaction_hash || record.hash || '';
}
