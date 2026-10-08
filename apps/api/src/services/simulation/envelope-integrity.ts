/**
 * Envelope-integrity and footprint-threat rules.
 *
 * Two closely related concerns live here because they answer the same question
 * from different angles — "does this envelope's own structure look like it was
 * built to be executed?":
 *
 *  - `analyzeFootprintThreats` turns a {@link FootprintDiff} into indicators.
 *    The diff itself is descriptive; this is where it becomes actionable.
 *  - `analyzeEnvelopeIntegrity` covers properties of the envelope that make it
 *    dangerous or unreviewable regardless of what it touches: a simulation that
 *    reverted, missing `timeBounds` (so a captured envelope stays replayable
 *    forever), unbounded resource limits, or a privileged call with no auth.
 *
 * All thresholds arrive as parameters so the whole rule set is testable without
 * mutating module state.
 */

import { tryParseAmountToStroops } from './amounts';
import { footprintContractIds, isEmptyFootprint } from './footprint-diff';
import type {
  EnvelopeResources,
  FootprintDiff,
  RiskIndicator,
  SimulatedOperation,
  SimulatedOutcome,
  TransactionFootprint,
} from './types';

export interface FootprintThreatThresholds {
  /** Declared read-write keys above this are flagged as unbounded growth. */
  maxFootprintReadWriteKeys: number;
  /** Distinct contract ids in the declared footprint that count as probing. */
  footprintProbeContractThreshold: number;
}

/**
 * Derives indicators from the declared-vs-required footprint diff.
 *
 * Every indicator keys off `diff.summary`, so a caller that computed the diff
 * elsewhere (e.g. auditing an envelope that already landed) gets identical
 * results without re-deriving the diff.
 */
export function analyzeFootprintThreats(
  diff: FootprintDiff,
  declaredFootprint: Partial<TransactionFootprint> | null | undefined,
  hasInvocation: boolean,
  thresholds: FootprintThreatThresholds,
): RiskIndicator[] {
  const indicators: RiskIndicator[] = [];
  const { summary } = diff;

  // ── Keys the host requires but the envelope never declared ───────────────
  const missing = diff.entries.filter((e) => e.change === 'missing');
  if (missing.length > 0) {
    const writeDowngrades = missing.filter((e) => e.requiredAccess === 'readWrite');
    const readOnlyMissing = missing.filter((e) => e.requiredAccess === 'readOnly');

    indicators.push({
      code: 'UNDECLARED_FOOTPRINT_ACCESS',
      category: 'footprint',
      severity: writeDowngrades.length > 0 ? 'critical' : 'medium',
      weight: writeDowngrades.length > 0 ? 35 : 14,
      title: `Envelope under-declares its footprint (${missing.length} key(s))`,
      detail:
        `The simulated footprint requires ${missing.length} ledger key(s) that the envelope does not ` +
        `declare${writeDowngrades.length > 0 ? `, including ${writeDowngrades.length} that must be read-write` : ''}. ` +
        'On a correct Soroban host the transaction traps rather than executing; against a permissive ' +
        'host this is an envelope whose real blast radius exceeds its declaration.',
      remediation:
        'Rebuild the envelope from a fresh `simulateTransaction` so the declared footprint matches the required one exactly. Never relax host resource enforcement to make an envelope fit.',
      evidence: {
        missingCount: missing.length,
        writeDowngradeCount: writeDowngrades.length,
        keys: missing.slice(0, 50).map((e) => ({
          key: e.key,
          entryType: e.entryType,
          requiredAccess: e.requiredAccess,
        })),
        keysTruncated: missing.length > 50,
      },
    });
  }

  // ── Declared readOnly but actually written ──────────────────────────────
  const modeDowngrades = diff.entries.filter(
    (e) => e.change === 'mode_changed' && e.declaredAccess === 'readOnly' && e.requiredAccess === 'readWrite',
  );
  if (modeDowngrades.length > 0) {
    indicators.push({
      code: 'FOOTPRINT_WRITE_DOWNGRADE',
      category: 'footprint',
      severity: 'critical',
      weight: 34,
      title: `Envelope declares ${modeDowngrades.length} key(s) read-only that it writes`,
      detail:
        `${modeDowngrades.length} ledger key(s) are declared in the read-only footprint while the host ` +
        'requires them read-write. In the audit trail this transaction claims to only *read* state it ' +
        'actually *modifies* — the difference between an observation and a mutation.',
      remediation:
        'Block execution. Treat a read-only declaration over a written key as a deliberate misdeclaration: regenerate the footprint and require the signer to confirm the contract writes these entries.',
      evidence: {
        count: modeDowngrades.length,
        keys: modeDowngrades.slice(0, 50).map((e) => ({
          key: e.key,
          entryType: e.entryType,
          contractId: e.contractId,
          declaredAccess: e.declaredAccess,
          requiredAccess: e.requiredAccess,
        })),
        keysTruncated: modeDowngrades.length > 50,
      },
    });
  }

  // ── Over-declared keys: touching state the envelope does not need ────────
  const unused = diff.entries.filter((e) => e.change === 'unused');
  if (unused.length > 0) {
    indicators.push({
      code: 'UNUSED_FOOTPRINT_ENTRIES',
      category: 'footprint',
      severity: 'low',
      weight: 5,
      title: `Envelope declares ${unused.length} unused footprint key(s)`,
      detail:
        `${unused.length} declared ledger key(s) are not touched by the simulated execution. ` +
        'Unused footprint entries inflate the resource budget and, more importantly, grant the ' +
        'transaction access to state it does not need.',
      remediation:
        'Regenerate the footprint. If the extra keys are intentional (e.g. a `RestoreFootprint` leg), document why; otherwise this is unnecessary access to unrelated ledger state.',
      evidence: {
        count: unused.length,
        keys: unused.slice(0, 50).map((e) => ({
          key: e.key,
          entryType: e.entryType,
          contractId: e.contractId,
          declaredAccess: e.declaredAccess,
        })),
        keysTruncated: unused.length > 50,
      },
    });
  }

  // ── Over-permission: declared read-write but only read ───────────────────
  const overPermissive = diff.entries.filter(
    (e) => e.change === 'mode_changed' && e.declaredAccess === 'readWrite' && e.requiredAccess === 'readOnly',
  );
  if (overPermissive.length > 0) {
    indicators.push({
      code: 'FOOTPRINT_OVER_PERMISSION',
      category: 'footprint',
      severity: 'medium',
      weight: 10,
      title: `Envelope claims write access to ${overPermissive.length} read-only key(s)`,
      detail:
        `${overPermissive.length} key(s) are declared read-write although the simulated execution only ` +
        'reads them. Declaring write access the transaction does not use expands what a compromised ' +
        'variant of this envelope would be able to mutate.',
      remediation: 'Tighten the footprint to the minimum access the execution requires.',
      evidence: {
        count: overPermissive.length,
        keys: overPermissive.slice(0, 50).map((e) => ({
          key: e.key,
          entryType: e.entryType,
          contractId: e.contractId,
        })),
      },
    });
  }

  // ── Unbounded footprint growth ───────────────────────────────────────────
  if (summary.declaredReadWrite > thresholds.maxFootprintReadWriteKeys) {
    indicators.push({
      code: 'UNBOUNDED_FOOTPRINT_GROWTH',
      category: 'footprint',
      severity: 'high',
      weight: 26,
      title: `Envelope declares ${summary.declaredReadWrite} read-write ledger keys`,
      detail:
        `The footprint claims ${summary.declaredReadWrite} writable ledger keys, above the configured ` +
        `ceiling of ${thresholds.maxFootprintReadWriteKeys}. A footprint that large is either a batch ` +
        'operation or a way to touch many unrelated positions in one atomic, all-or-nothing transaction.',
      remediation:
        'Confirm the batch size is intended. If the keys span unrelated accounts or positions, this is a single-transaction sweep and should be split and reviewed per batch.',
      evidence: {
        declaredReadWrite: summary.declaredReadWrite,
        threshold: thresholds.maxFootprintReadWriteKeys,
        distinctContracts: summary.contractIdCount,
      },
    });
  }

  // ── Footprint probing across many contracts ──────────────────────────────
  const spannedContracts = footprintContractIds(declaredFootprint);
  if (spannedContracts.length >= thresholds.footprintProbeContractThreshold) {
    indicators.push({
      code: 'FOOTPRINT_KEY_PROBING',
      category: 'footprint',
      severity: 'high',
      weight: 22,
      title: `Footprint spans ${spannedContracts.length} distinct contracts`,
      detail:
        `The declared footprint touches ${spannedContracts.length} unrelated contracts ` +
        `(${spannedContracts.slice(0, 10).join(', ')}${spannedContracts.length > 10 ? ', …' : ''}), ` +
        `at or above the reconnaissance threshold of ${thresholds.footprintProbeContractThreshold}. ` +
        'A footprint scattered across unrelated contracts is how an envelope reads many positions ' +
        'atomically — a prerequisite for copying them out.',
      remediation:
        'Confirm every contract in the footprint is part of the intended operation. A legitimate ' +
        'operation touches a small, related set of contracts; a scattered one is harvesting.',
      evidence: {
        contractCount: spannedContracts.length,
        threshold: thresholds.footprintProbeContractThreshold,
        contractIds: spannedContracts.slice(0, 50),
        contractIdsTruncated: spannedContracts.length > 50,
      },
    });
  }

  // ── Soroban invocation with an entirely empty footprint ──────────────────
  //
  // Checked against the *declared* footprint (not a freshly-constructed empty
  // one): the condition is "this envelope declares zero keys while calling a
  // contract", so it must be answered by what the caller actually declared.
  if (hasInvocation && declaredFootprint && isEmptyFootprint(declaredFootprint)) {
    indicators.push({
      code: 'EMPTY_FOOTPRINT_WITH_INVOCATION',
      category: 'footprint',
      severity: 'high',
      weight: 24,
      title: 'Soroban invocation with an empty declared footprint',
      detail:
        `The envelope invokes a contract but declares no footprint at all, while the simulated ` +
        `execution requires ${summary.requiredReadOnly + summary.requiredReadWrite} key(s). ` +
        'An envelope that declares nothing yet calls a contract is malformed at best and a ' +
        'footprint-avoidance attempt at worst.',
      remediation:
        'Reject. A Soroban envelope must carry the footprint returned by `simulateTransaction`; regenerate it before submission.',
      evidence: {
        declaredReadOnly: summary.declaredReadOnly,
        declaredReadWrite: summary.declaredReadWrite,
        requiredTotal: summary.requiredReadOnly + summary.requiredReadWrite,
      },
    });
  }

  // ── Archived keys in the declared footprint ──────────────────────────────
  const archivedKeys = diff.entries.filter(
    (e) => e.declaredAccess === 'archived' || e.requiredAccess === 'archived',
  );
  if (archivedKeys.length > 0) {
    const unexpected = archivedKeys.filter((e) => e.change === 'unused');
    indicators.push({
      code: 'ARCHIVED_KEY_ACCESS',
      category: 'footprint',
      severity: unexpected.length > 0 ? 'high' : 'medium',
      weight: unexpected.length > 0 ? 20 : 12,
      title: `Envelope declares ${archivedKeys.length} archived ledger key(s)`,
      detail:
        `${archivedKeys.length} archived ledger key(s) are declared${unexpected.length > 0 ? `, of which ${unexpected.length} are not required by the simulated execution` : ''}. ` +
        'Resurrecting archived state costs rent proportional to the entry size and is a way to bring ' +
        'long-dormant positions back under an attacker’s control.',
      remediation:
        'Confirm each restore is intended and budgeted. Unnecessary archived-key access is a strong ' +
        'signal that the envelope is reviving state nobody recently touched.',
      evidence: {
        archivedCount: archivedKeys.length,
        unexpectedCount: unexpected.length,
        keys: archivedKeys.slice(0, 50).map((e) => ({
          key: e.key,
          entryType: e.entryType,
          contractId: e.contractId,
          change: e.change,
        })),
      },
    });
  }

  return indicators;
}

export interface EnvelopeIntegrityInput {
  sourceAccount: string;
  operations: SimulatedOperation[];
  resources?: EnvelopeResources;
  outcome?: SimulatedOutcome;
  /** True when at least one contract invocation is present. */
  hasInvocation: boolean;
  /** True when the caller supplied an existing host simulation result. */
  simulated: boolean;
}

/**
 * Indicators derived from the envelope's own shape and the outcome of any
 * simulation the caller ran.
 *
 * A reverted simulation is reported rather than treated as a hard failure: an
 * envelope that traps may be entirely benign (a typo'd amount) or may be the
 * *intended* outcome of an attack that needs the transaction to fail (e.g. a
 * `RestoreFootprint` probe). Either way the signer cannot verify safety from a
 * failed simulation, which is the actionable fact.
 */
export function analyzeEnvelopeIntegrity(input: EnvelopeIntegrityInput): RiskIndicator[] {
  const indicators: RiskIndicator[] = [];
  const { resources, outcome, operations } = input;

  if (outcome && outcome.success === false) {
    const firstError = outcome.errors?.[0];
    indicators.push({
      code: 'SIMULATION_REVERTED',
      category: 'envelope',
      severity: 'high',
      weight: 20,
      title: 'Pre-execution simulation reverted',
      detail:
        `Simulating the envelope against ledger ${outcome.ledger ?? 'unknown'} failed` +
        `${firstError ? ` with ${firstError.type}${firstError.code !== undefined ? ` (${firstError.code})` : ''}: ${firstError.message}` : ''}. ` +
        'A reverted simulation means the safety of this envelope cannot be verified before signing.',
      remediation:
        'Do not sign on the basis of a failed simulation. Fix the failure and re-simulate, or confirm with the signer that a revert is the intended outcome.',
      evidence: {
        ledger: outcome.ledger ?? null,
        errorCount: outcome.errors?.length ?? 0,
        errors: outcome.errors ?? [],
      },
    });
  }

  if (outcome && outcome.errors && outcome.errors.length > 0 && outcome.success !== false) {
    const hostErrors = outcome.errors.filter((e) => e.type === 'host_error' || e.type === 'panic');
    if (hostErrors.length > 0) {
      indicators.push({
        code: 'SIMULATION_HOST_ERRORS',
        category: 'envelope',
        severity: 'medium',
        weight: 12,
        title: `Simulation raised ${hostErrors.length} host-level error(s)`,
        detail:
          `The simulation produced ${hostErrors.length} host error(s)/panic(s) ` +
          `(${hostErrors.slice(0, 3).map((e) => e.message).join('; ')}) even though the envelope is ` +
          'marked successful. Host errors during pre-execution frequently mean a contract reached a ' +
          'branch its author did not expect.',
        remediation:
          'Read the contract around the erroring call site. A panic or storage/budget error in ' +
          'pre-execution is often the fingerprint of an integer-overflow or division-by-zero drain.',
        evidence: { errors: hostErrors.slice(0, 20), totalErrorCount: outcome.errors.length },
      });
    }
  }

  if (!input.simulated) {
    indicators.push({
      code: 'NO_SIMULATION_RESULT',
      category: 'envelope',
      severity: 'medium',
      weight: 10,
      title: 'Envelope was never simulated',
      detail:
        'No host simulation result was supplied, so the footprint diff and balance delta in this ' +
        'report rest on the caller’s description of the envelope rather than on executed state. ' +
        'The score is therefore a lower bound on the real risk.',
      remediation:
        'Run `simulateTransaction` against the target network and re-analyze with the result attached. ' +
        'Treat this score as incomplete until then.',
      evidence: { operationCount: operations.length },
    });
  }

  if (resources && resources.hasTimeBounds === false) {
    indicators.push({
      code: 'MISSING_TIME_BOUNDS',
      category: 'envelope',
      severity: 'medium',
      weight: 12,
      title: 'Envelope declares no time bounds',
      detail:
        'Without `preconditions.timeBounds` the envelope remains valid until its sequence number ' +
        'is consumed. An intercepted, unsigned envelope captured now can be submitted later, outside ' +
        'any window the signer had in mind.',
      remediation:
        'Set `timeBounds` to a short validity window. Revoke the source account’s sequence number if ' +
        'the envelope was ever transmitted without one.',
      evidence: { hasTimeBounds: false },
    });
  }

  if (resources && (resources.ledgerBounds === null || resources.ledgerBounds === undefined)) {
    indicators.push({
      code: 'UNBOUNDED_RESOURCE_LIMITS',
      category: 'envelope',
      severity: 'low',
      weight: 5,
      title: 'Envelope declares no Soroban resource bounds',
      detail:
        'The envelope sets no `SorobanResources.ledgerBounds`, so it carries no explicit CPU, memory, ' +
        'or storage ceiling. It remains subject to the network maximum, but the signer has not ' +
        'constrained what the invocation may consume.',
      remediation:
        'Set `ledgerBounds` to the smallest values that satisfy the simulation, so the envelope cannot ' +
        'be re-signed with a larger allowance.',
      evidence: { ledgerBounds: null },
    });
  }

  const zeroResourceBound = resources?.ledgerBounds?.max === 0;
  if (zeroResourceBound) {
    indicators.push({
      code: 'ZERO_RESOURCE_LIMITS',
      category: 'envelope',
      severity: 'medium',
      weight: 12,
      title: 'Envelope declares a zero ledger bounds maximum',
      detail:
        '`ledgerBounds.max` is 0, which cannot execute any Soroban work. An envelope with an ' +
        'unusable resource declaration either traps immediately or exists only to carry its operations ' +
        'for a later re-signed variant.',
      remediation: 'Reject, or regenerate the envelope with bounds that match the simulation.',
      evidence: { ledgerBounds: resources?.ledgerBounds },
    });
  }

  // ── Fee sanity: a zero-fee Soroban envelope ─────────────────────────────
  //
  // Parsed with the exact stroop helper rather than `Number.parseInt`, which
  // would stop at the decimal point and read a fee of `0.00001` (100 stroops,
  // the minimum Soroban resource fee) as zero.
  const feeStroops = resources?.feeStroops !== undefined ? tryParseAmountToStroops(resources.feeStroops) : null;
  if (resources?.feeStroops !== undefined && feeStroops === 0n) {
    indicators.push({
      code: 'ZERO_FEE_SOROBAN_ENVELOPE',
      category: 'envelope',
      severity: 'low',
      weight: 5,
      title: 'Soroban envelope declares a zero fee',
      detail:
        'The envelope declares a fee of 0 stroops while performing contract work. A fee-bumped ' +
        'replacement can be submitted with an arbitrarily large fee against the same envelope, so a ' +
        'zero-fee envelope does not pin the transaction to low priority.',
      remediation: 'Set an explicit fee ceiling so the envelope cannot be re-signed at a higher priority.',
      evidence: { feeStroops: resources.feeStroops },
    });
  }

  return indicators;
}
