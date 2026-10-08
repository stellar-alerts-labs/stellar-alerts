/**
 * Footprint diffing for Soroban transaction envelopes.
 *
 * A Soroban envelope must declare a **footprint**: the exact set of ledger keys
 * the host will read (`readOnly`) and write (`readWrite`), plus any `archived`
 * keys it intends to restore. The host enforces this — a write to a key that
 * wasn't declared `readWrite` traps the whole transaction. That enforcement is
 * what makes the footprint a *declaration of intent*, and comparing it against
 * the footprint the host actually requires is a genuine pre-execution signal:
 *
 *  - **missing** keys (required but not declared) mean the envelope under-declares
 *    its blast radius. On mainnet this reverts; against a permissive/older host,
 *    or when combined with a value transfer, it is the shape of a deliberately
 *    under-specified envelope.
 *  - **unused** keys (declared but not required) mean the envelope touches state
 *    the transaction does not need — either accidental over-breadth or deliberate
 *    probing of unrelated contracts/accounts.
 *  - **mode_changed** keys are the sharpest signal: declaring a key `readOnly`
 *    that the host requires as `readWrite` is an under-declared *write*, which is
 *    the difference between "reads" and "modifies" in the audit trail.
 *
 * The diff is a pure function of two `TransactionFootprint` values so it can be
 * tested exhaustively without a host, and reused by the simulation API, the
 * alerting workers, and (later) a watcher that audits already-landed envelopes.
 */

import type {
  FootprintChange,
  FootprintDiff,
  FootprintDiffEntry,
  FootprintAccess,
  FootprintKey,
  TransactionFootprint,
} from './types';

/** Canonical identity for a ledger key. */
function keyId(key: Pick<FootprintKey, 'key'>): string {
  return key.key;
}

/**
 * Normalizes a possibly-partial footprint into complete arrays.
 *
 * Callers frequently have only one side of a footprint (e.g. an envelope that
 * declares nothing because it isn't Soroban), and `undefined`/`null` collections
 * are normal from decoded XDR, so every collection is coerced to an array here
 * exactly once.
 */
export function normalizeFootprint(
  footprint: Partial<TransactionFootprint> | null | undefined,
): TransactionFootprint {
  return {
    readOnly: footprint?.readOnly ?? [],
    readWrite: footprint?.readWrite ?? [],
    archived: footprint?.archived ?? [],
  };
}

/**
 * Builds a footprint key set keyed by canonical id.
 *
 * Duplicate ids within a single access list are collapsed: the host treats a
 * repeated key as a single access, so counting it twice would inflate the diff
 * summary.
 */
export function indexFootprint(
  footprint: Partial<TransactionFootprint> | null | undefined,
): Map<string, FootprintKey> {
  const normalized = normalizeFootprint(footprint);
  const index = new Map<string, FootprintKey>();

  for (const bucket of [normalized.readOnly, normalized.readWrite, normalized.archived]) {
    for (const key of bucket) {
      const id = keyId(key);
      if (index.has(id)) continue;
      index.set(id, { ...key, access: key.access });
    }
  }

  return index;
}

/**
 * Classifies a single key's declared vs required access.
 *
 * `mode_changed` covers both directions, and the caller distinguishes a
 * write-downgrade (declared `readOnly`, required `readWrite`) from a
 * write-upgrade via `declaredAccess`/`requiredAccess` on the returned entry.
 */
function classify(
  declared: FootprintKey | undefined,
  required: FootprintKey | undefined,
): FootprintChange {
  if (!declared) return 'missing';
  if (!required) return 'unused';
  return declared.access === required.access ? 'unchanged' : 'mode_changed';
}

/**
 * Builds the per-key diff between the footprint an envelope **declares** and
 * the footprint the host says it **requires**.
 *
 * The result is ordered deterministically (`key` ascending) so that two runs
 * over the same inputs produce byte-identical output — which matters because
 * reports are persisted and compared across requests.
 */
export function diffFootprints(
  declared: Partial<TransactionFootprint> | null | undefined,
  required: Partial<TransactionFootprint> | null | undefined,
): FootprintDiff {
  const declaredNorm = normalizeFootprint(declared);
  const requiredNorm = normalizeFootprint(required);
  const declaredIndex = indexFootprint(declaredNorm);
  const requiredIndex = indexFootprint(requiredNorm);

  const allIds = new Set<string>([...declaredIndex.keys(), ...requiredIndex.keys()]);
  const sortedIds = [...allIds].sort();

  const entries: FootprintDiffEntry[] = sortedIds.map((id) => {
    const declaredKey = declaredIndex.get(id);
    const requiredKey = requiredIndex.get(id);
    const reference = requiredKey ?? declaredKey!;

    return {
      key: id,
      entryType: reference.entryType,
      ...(reference.contractId ? { contractId: reference.contractId } : {}),
      change: classify(declaredKey, requiredKey),
      ...(declaredKey ? { declaredAccess: declaredKey.access } : {}),
      ...(requiredKey ? { requiredAccess: requiredKey.access } : {}),
    };
  });

  const changed = entries.filter((e) => e.change !== 'unchanged');
  const contractIds = new Set<string>();
  for (const bucket of [declaredNorm.readOnly, declaredNorm.readWrite, declaredNorm.archived]) {
    for (const key of bucket) {
      if (key.contractId) contractIds.add(key.contractId);
    }
  }

  return {
    entries,
    summary: {
      declaredReadOnly: declaredNorm.readOnly.length,
      declaredReadWrite: declaredNorm.readWrite.length,
      declaredArchived: declaredNorm.archived.length,
      requiredReadOnly: requiredNorm.readOnly.length,
      requiredReadWrite: requiredNorm.readWrite.length,
      requiredArchived: requiredNorm.archived.length,
      missingCount: changed.filter((e) => e.change === 'missing').length,
      unusedCount: changed.filter((e) => e.change === 'unused').length,
      modeChangedCount: changed.filter((e) => e.change === 'mode_changed').length,
      contractIdCount: contractIds.size,
    },
  };
}

/** True when a key is declared as writable in the given footprint. */
export function isDeclaredWritable(
  footprint: Partial<TransactionFootprint> | null | undefined,
  key: string,
): boolean {
  const normalized = normalizeFootprint(footprint);
  return normalized.readWrite.some((k) => keyId(k) === key);
}

/** Access mode a key is declared under, or `undefined` when it isn't declared. */
export function declaredAccessFor(
  footprint: Partial<TransactionFootprint> | null | undefined,
  key: string,
): FootprintAccess | undefined {
  const normalized = normalizeFootprint(footprint);
  for (const bucket of [normalized.readWrite, normalized.readOnly, normalized.archived]) {
    const match = bucket.find((k) => keyId(k) === key);
    if (match) return match.access;
  }
  return undefined;
}

/**
 * Contract ids the declared footprint spans, deduplicated and sorted.
 * Used by the footprint-probing rule, which treats a footprint scattered across
 * many unrelated contracts as a reconnaissance signal.
 */
export function footprintContractIds(
  footprint: Partial<TransactionFootprint> | null | undefined,
): string[] {
  const normalized = normalizeFootprint(footprint);
  const ids = new Set<string>();
  for (const bucket of [normalized.readOnly, normalized.readWrite, normalized.archived]) {
    for (const key of bucket) {
      if (key.contractId) ids.add(key.contractId);
    }
  }
  return [...ids].sort();
}

/** True when the envelope declares an entirely empty footprint. */
export function isEmptyFootprint(
  footprint: Partial<TransactionFootprint> | null | undefined,
): boolean {
  const normalized = normalizeFootprint(footprint);
  return (
    normalized.readOnly.length === 0 &&
    normalized.readWrite.length === 0 &&
    normalized.archived.length === 0
  );
}
