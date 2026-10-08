/**
 * Typed contracts for Soroban RPC event records returned by
 * `sorobanServer.getEvents()`.
 *
 * The Soroban RPC `getEvents` response returns raw event objects with
 * base64-XDR topic arrays and ScVal data blobs.  Previously these were
 * passed around as `any`, hiding shape mismatches.  This module defines the
 * minimal typed surface that the watcher worker and soroban.ts actually
 * inspect, enabling TypeScript to enforce that callers access only known
 * fields.
 *
 * Note: the deeper `topic` / `value` ScVal decoding is performed by
 * lib/stellar.ts#parseSacTransferEvent; this type only describes the
 * *container* shape that wraps those raw blobs.
 */

// ── Raw Soroban RPC event ──────────────────────────────────────────────────

/**
 * A single Soroban contract event as returned by
 * `rpc.Server.getEvents()`.  Only the fields that the watcher /
 * soroban router actually read are declared here; the Stellar SDK may
 * surface additional metadata that we don't need to model.
 */
export interface SorobanRpcEvent {
  /** Contract address that emitted the event. */
  contractId?: string;
  /** Ledger sequence number where the event was emitted. */
  ledger?: number;
  /**
   * Ledger sequence, enriched by the `fetchContractEventsInRange`
   * generator when it sets `ledgerSeq = evt.ledger || currentStart`.
   */
  ledgerSeq?: number;
  /**
   * Transaction hash the event was emitted in.  Present on RPC
   * `getEvents` responses; null/undefined on some Horizon payloads.
   */
  txHash?: string | null;
  /**
   * Raw topic array.  Each element is an ScVal object or, for some
   * simplified payloads (e.g. from tests), already a decoded string /
   * { symbol: string } shape.
   */
  topic?: unknown[];
  /**
   * Raw ScVal event value / data blob, or a pre-decoded { from, to,
   * amount } shape from simplified payloads.
   */
  value?: unknown;
  data?: unknown;
  /**
   * Asset metadata enriched by some indexers (not present on raw RPC
   * responses; the parseSacTransferEvent decoder falls back to the
   * topic / value blobs if absent).
   */
  assetCode?: string | null;
  assetIssuer?: string | null;
}

// ── Enriched event (output of fetchContractEventsInRange) ─────────────────

/**
 * An SorobanRpcEvent enriched with a stable `ledgerSeq` field by the
 * `fetchContractEventsInRange` generator so that downstream callers
 * never need to fall back to `(parsed as any).ledgerSeq`.
 */
export interface EnrichedSorobanEvent extends SorobanRpcEvent {
  /** Always present — set to `evt.ledger` or the batch's `currentStart`. */
  ledgerSeq: number;
}

// ── Type guard ─────────────────────────────────────────────────────────────

export function isEnrichedSorobanEvent(
  event: SorobanRpcEvent,
): event is EnrichedSorobanEvent {
  return typeof event.ledgerSeq === 'number';
}

export function asEnrichedSorobanEvents(value: unknown): EnrichedSorobanEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isEnrichedSorobanEvent);
}
