/**
 * sac-metadata-cache.ts
 *
 * Auto-discovery cache for Stellar Asset Contract (SAC) decimals and metadata.
 * Metadata is fetched from the Soroban RPC on first access and held in memory
 * for CACHE_TTL_MS before being considered stale.
 */
import { sorobanServer } from './soroban';

export interface SACMetadata {
  contractId: string;
  assetCode: string;
  assetIssuer: string;
  decimals: number;
  /** Unix timestamp (ms) at which the entry was placed in the cache. */
  cachedAt: number;
}

/** How long a cache entry is considered fresh (30 minutes). */
const CACHE_TTL_MS = 30 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Decodes a raw ScVal (or its already-decoded native form) into a string.
 * Returns an empty string when the value cannot be decoded.
 */
function decodeScString(scVal: any): string {
  if (scVal === null || scVal === undefined) return '';

  // Already a primitive string
  if (typeof scVal === 'string') return scVal;

  // Native object shapes produced by stellar-sdk v13 scValToNative
  if (typeof scVal === 'object') {
    if (typeof scVal.symbol === 'string') return scVal.symbol;
    if (typeof scVal.string === 'string') return scVal.string;
    if (typeof scVal.bytes !== 'undefined') {
      try {
        return Buffer.from(scVal.bytes).toString('utf8');
      } catch {
        return '';
      }
    }

    // Last resort: try stellar-sdk scValToNative
    try {
      const { scValToNative } = require('stellar-sdk') as typeof import('stellar-sdk');
      const native = scValToNative(scVal);
      if (typeof native === 'string') return native;
    } catch {
      return '';
    }
  }

  return '';
}

/**
 * Decodes a raw ScVal into a number (used for the `decimals` field).
 */
function decodeScU32(scVal: any): number | null {
  if (scVal === null || scVal === undefined) return null;

  if (typeof scVal === 'number' && Number.isInteger(scVal)) return scVal;
  if (typeof scVal === 'bigint') return Number(scVal);

  if (typeof scVal === 'object') {
    if (typeof scVal.u32 === 'number') return scVal.u32;
    try {
      const { scValToNative } = require('stellar-sdk') as typeof import('stellar-sdk');
      const native = scValToNative(scVal);
      if (typeof native === 'number') return native;
      if (typeof native === 'bigint') return Number(native);
    } catch {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// SACMetadataCache
// ---------------------------------------------------------------------------

export class SACMetadataCache {
  private cache = new Map<string, SACMetadata>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns SAC metadata for a contract ID, fetching from RPC if not cached
   * or if the cached entry is stale.
   *
   * Parses the token name / symbol / decimals from the contract's instance
   * storage data entries.  Returns `null` when the RPC call fails or the
   * contract does not expose the expected metadata fields.
   */
  async get(contractId: string): Promise<SACMetadata | null> {
    if (this.isFresh(contractId)) {
      return this.cache.get(contractId)!;
    }

    // Fetch from RPC
    try {
      const metadata = await this._fetchFromRpc(contractId);
      if (metadata) {
        this.cache.set(contractId, metadata);
        return metadata;
      }
    } catch (err: any) {
      console.warn(
        `[SACMetadataCache] Failed to fetch metadata for ${contractId}: ${err?.message ?? err}`
      );
    }

    return null;
  }

  /**
   * Pre-warm the cache with a list of known SAC contract IDs.
   * Errors for individual contracts are swallowed so the warm-up completes.
   */
  async warmup(contractIds: string[]): Promise<void> {
    await Promise.allSettled(contractIds.map((id) => this.get(id)));
  }

  /**
   * Manually set metadata for a contract (useful for well-known contracts
   * such as USDC whose metadata is stable and does not need an RPC round-trip).
   */
  set(contractId: string, metadata: Omit<SACMetadata, 'cachedAt'>): void {
    this.cache.set(contractId, { ...metadata, cachedAt: Date.now() });
  }

  /**
   * Returns `true` if the cache entry for `contractId` exists and has not
   * yet exceeded CACHE_TTL_MS.
   */
  isFresh(contractId: string): boolean {
    const entry = this.cache.get(contractId);
    if (!entry) return false;
    return Date.now() - entry.cachedAt < CACHE_TTL_MS;
  }

  /**
   * Evicts all stale entries from the cache.
   */
  evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.cache.entries()) {
      if (now - entry.cachedAt >= CACHE_TTL_MS) {
        this.cache.delete(id);
      }
    }
  }

  /** Number of entries currently held in the cache (stale or fresh). */
  size(): number {
    return this.cache.size;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetches and parses SAC metadata from the Soroban RPC.
   *
   * SAC contracts store their metadata (name, symbol, decimals) as contract
   * instance storage entries.  We retrieve the instance entry and walk its
   * storage map to locate the relevant keys.
   */
  private async _fetchFromRpc(contractId: string): Promise<SACMetadata | null> {
    // Dynamically import stellar-sdk to allow unit tests to mock it.
    const StellarSdk = require('stellar-sdk');
    const xdr = StellarSdk.xdr;

    const contractAddress = new StellarSdk.Address(contractId);
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractAddress.toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );

    const response = await sorobanServer.getLedgerEntries(instanceKey);
    const entries: any[] = response?.entries ?? [];

    if (entries.length === 0) {
      return null;
    }

    // Parse the contract instance storage map for well-known SAC fields.
    let assetCode = '';
    let assetIssuer = '';
    let decimals = 7; // SAC default

    for (const entry of entries) {
      try {
        const contractData = entry.val?.contractData?.() ?? entry.val;
        const instance = contractData?.val?.instance?.() ?? contractData?.val;
        const storage: any[] = instance?.storage?.() ?? [];

        for (const storageEntry of storage) {
          let keyStr = '';
          try {
            keyStr = decodeScString(storageEntry.key?.() ?? storageEntry.key);
          } catch {
            keyStr = String(storageEntry.key ?? '');
          }

          const rawVal = storageEntry.val?.() ?? storageEntry.val;

          if (keyStr === 'METADATA' || keyStr === 'metadata') {
            // Metadata map contains 'name', 'symbol', 'decimal'
            const mapEntries: any[] = rawVal?.map?.() ?? rawVal?.map ?? [];
            for (const mapEntry of mapEntries) {
              const mk = decodeScString(mapEntry.key?.() ?? mapEntry.key);
              const mv = mapEntry.val?.() ?? mapEntry.val;
              if (mk === 'symbol' || mk === 'SYMBOL') assetCode = decodeScString(mv);
              if (mk === 'name' || mk === 'NAME') {
                // 'name' often carries "ASSET:ISSUER" for SACs
                const parsed = decodeScString(mv);
                if (!assetCode) assetCode = parsed;
              }
              if (mk === 'decimal' || mk === 'decimals' || mk === 'DECIMALS') {
                decimals = decodeScU32(mv) ?? 7;
              }
            }
          }

          // Direct top-level keys
          if ((keyStr === 'symbol' || keyStr === 'SYMBOL') && !assetCode) {
            assetCode = decodeScString(rawVal);
          }
          if (keyStr === 'decimal' || keyStr === 'decimals') {
            decimals = decodeScU32(rawVal) ?? 7;
          }
          if (keyStr === 'issuer' || keyStr === 'ISSUER') {
            assetIssuer = decodeScString(rawVal);
          }
        }
      } catch {
        // best-effort per entry
      }
    }

    return {
      contractId,
      assetCode: assetCode || contractId,
      assetIssuer,
      decimals,
      cachedAt: Date.now(),
    };
  }
}

/** Singleton cache instance – import this wherever SAC metadata is needed. */
export const sacMetadataCache = new SACMetadataCache();
