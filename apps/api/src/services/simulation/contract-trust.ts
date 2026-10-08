/**
 * Unverified-contract-interaction detection.
 *
 * A Soroban envelope's power is entirely delegated to the contracts it invokes:
 * an `InvokeContract` is a call into code the signer usually cannot read, and a
 * single invocation can move an unbounded amount of value. "Is that contract
 * trustworthy?" is therefore a first-class pre-execution question, and this
 * module answers it from two independent inputs:
 *
 *  1. **Operator trust registry** — which contracts have been verified, against
 *     which audited WASM hash, and deployed by whom.
 *  2. **Observed on-ledger state** — the WASM hash the contract instance entry
 *     actually records, and whether the contract is deployed at all.
 *
 * Comparing the two catches the case a single source cannot: a contract that was
 * verified against hash `A` but whose instance entry now records hash `B` — i.e.
 * an upgraded or re-pointed contract, which is exactly the shape of a
 * `setTrustlineFlags`-style backdoor dropped into an otherwise-legitimate
 * protocol.
 *
 * Every rule here reports through the same `RiskIndicator` shape as the
 * footprint and drain rules, and all of them are reconcilable: a contract is
 * only called "unverified" when the registry positively lacks a verified record
 * for it, never merely because the registry was not supplied.
 */

import type {
  ContractInteraction,
  ContractInteractionAnalysis,
  ContractStateSnapshot,
  ContractTrustRecord,
  ContractTrustRegistry,
  RiskIndicator,
  SimulatedOperation,
} from './types';

/**
 * Soroban entry points that change authority over a contract or its assets.
 * Calling one of these is equivalent to admin access, so it deserves a much
 * higher bar than an ordinary transfer even on a verified contract.
 *
 * Matched case-insensitively as a substring of the function name because
 * contracts conventionally name these with the `set_*` / `remove_*` prefix
 * (e.g. `set_admin`, `remove_contract`, `set_trustline_flags`).
 */
const PRIVILEGED_FUNCTION_NAMES: readonly string[] = [
  'set_admin',
  'transfer_admin',
  'remove_contract',
  'upgrade_contract',
  'upgrade',
  'mint',
  'burn',
  'freeze',
  'unfreeze',
  'set_trustline_flags',
  'set_panic',
  'set_events',
  'deploy',
];

/** Operations that bring a contract into existence during this envelope. */
const DEPLOY_KINDS: ReadonlySet<string> = new Set(['createContract', 'uploadWasm']);

/** True when a contract function name is an authority-changing entry point. */
export function isPrivilegedFunction(fn: string | undefined): boolean {
  if (!fn) return false;
  const normalized = fn.toLowerCase();
  return PRIVILEGED_FUNCTION_NAMES.some((name) => normalized.includes(name));
}

/** Accepts a `Map`, a plain record, or `undefined` and yields a uniform lookup. */
function indexRecords(
  source: Map<string, ContractTrustRecord> | Record<string, ContractTrustRecord> | undefined,
): Map<string, ContractTrustRecord> {
  if (!source) return new Map();
  if (source instanceof Map) return source;
  return new Map(Object.entries(source));
}

/** Accepts a `Set` or an array and yields a uniform membership test. */
function toSet(source: Set<string> | string[] | undefined): Set<string> {
  if (!source) return new Set();
  return source instanceof Set ? source : new Set(source);
}

export interface ContractThresholds {
  /** Invocations of one contract in a single envelope that count as fan-out. */
  maxInvocationsPerContract: number;
}

/**
 * Analyses every contract the envelope touches, and returns both the
 * per-contract breakdown and the contract-category risk indicators.
 */
export function analyzeContractInteractions(
  sourceAccount: string,
  operations: SimulatedOperation[],
  contracts: ContractStateSnapshot[] | undefined,
  trustRegistry: ContractTrustRegistry | undefined,
  authEntries: { contractId?: string; function?: string }[] | undefined,
  thresholds: ContractThresholds,
): { analysis: ContractInteractionAnalysis; indicators: RiskIndicator[] } {
  const indicators: RiskIndicator[] = [];

  const records = indexRecords(trustRegistry?.byContractId);
  const allowlist = toSet(trustRegistry?.allowlist);
  const trustedDeployers = toSet(trustRegistry?.trustedDeployers);

  const stateById = new Map<string, ContractStateSnapshot>();
  for (const snapshot of contracts ?? []) {
    stateById.set(snapshot.contractId, snapshot);
  }

  // Auth coverage, keyed by `contractId::function`.
  const authKeys = new Set<string>();
  for (const entry of authEntries ?? []) {
    if (entry.contractId) authKeys.add(`${entry.contractId}::${entry.function ?? '*'}`);
    authKeys.add(`${entry.contractId ?? '*'}::*`);
  }
  const hasAuthFor = (contractId: string, fn: string | undefined) =>
    authKeys.has(`${contractId}::${fn ?? '*'}`) || authKeys.has(`${contractId}::*`);

  const interactionsByContract = new Map<string, ContractInteraction>();
  const privilegedInvocations: SimulatedOperation[] = [];
  const unknownDeployers = new Set<string>();
  const codeHashMismatches = new Set<string>();
  const unverifiableContracts = new Set<string>();

  // Contracts created inside this envelope are tracked separately so a
  // deploy-then-invoke in one transaction is detectable.
  const deployedInEnvelope = new Map<string, string>();
  for (const operation of operations) {
    if (DEPLOY_KINDS.has(operation.kind) && operation.contractId) {
      deployedInEnvelope.set(operation.contractId, (operation.source ?? sourceAccount));
    }
  }

  for (const operation of operations) {
    if (operation.kind !== 'invokeContract' || !operation.contractId) continue;

    const contractId = operation.contractId;
    const fn = operation.function;

    let interaction = interactionsByContract.get(contractId);
    if (!interaction) {
      const record = records.get(contractId);
      const state = stateById.get(contractId);
      const allowlisted = allowlist.has(contractId);

      // "Verified" is positive evidence only: either the operator explicitly
      // allow-listed the contract, or a registry record says it was verified and
      // (when a hash is recorded) that the hash matches what is on-ledger.
      const recordedHash = record?.wasmHash?.toLowerCase();
      const observedHash = state?.wasmHash?.toLowerCase();
      const hashMismatch =
        Boolean(recordedHash) && Boolean(observedHash) && recordedHash !== observedHash;

      const verified = allowlisted || (record?.verified === true && !hashMismatch);

      interaction = {
        contractId,
        functions: [],
        invocationCount: 0,
        deployedInEnvelope: deployedInEnvelope.has(contractId),
        missingAuth: false,
        verified,
        codeHashMismatch: hashMismatch,
        known: allowlisted || record !== undefined,
      };
      interactionsByContract.set(contractId, interaction);
    }

    interaction.invocationCount++;
    if (fn && !interaction.functions.includes(fn)) interaction.functions.push(fn);
    if (!hasAuthFor(contractId, fn)) interaction.missingAuth = true;

    if (isPrivilegedFunction(fn)) {
      privilegedInvocations.push(operation);

      // An authority-changing call with no authorization entry is the single
      // strongest signal in this module: the envelope asks a contract to grant or
      // revoke power while carrying nothing that proves the signer may.
      if (!hasAuthFor(contractId, fn)) {
        indicators.push({
          code: 'PRIVILEGED_FUNCTION_WITHOUT_AUTH',
          category: 'contract',
          severity: 'critical',
          weight: 42,
          title: `Unauthenticated privileged call to ${contractId}.${fn}`,
          detail:
            `The envelope invokes \`${fn}\` on ${contractId} — an authority-changing entry point — ` +
            'but declares no Soroban authorization entry covering it. Without signed auth the ' +
            'contract is being asked to change ownership or supply with nothing attesting the ' +
            "signer's authority.",
          remediation:
            'Block execution. A privileged invocation must carry a matching SorobanAuthorizationEntry signed by the contract admin; treat its absence as an attempted unauthorized takeover.',
          evidence: {
            contractId,
            function: fn,
            declaredAuthEntryCount: authKeys.size,
          },
        });
      } else {
        indicators.push({
          code: 'PRIVILEGED_CONTRACT_FUNCTION',
          category: 'contract',
          severity: 'high',
          weight: 24,
          title: `Envelope calls privileged function ${contractId}.${fn}`,
          detail:
            `\`${fn}\` on ${contractId} changes authority over the contract or its assets ` +
            '(admin transfer, upgrade, mint/burn, freeze, or contract removal). ' +
            'A correct authorization entry is present, so this is reviewable rather than ' +
            'an attack in itself — but it is never routine.',
          remediation:
            'Confirm with the protocol team that this administrative change was scheduled and intended, and verify the new admin address before signing.',
          evidence: {
            contractId,
            function: fn,
          },
        });
      }
    }
  }

  // ── Rule: unverified contract invocation ────────────────────────────────

  for (const interaction of [...interactionsByContract.values()].sort((a, b) =>
    a.contractId.localeCompare(b.contractId),
  )) {
    const state = stateById.get(interaction.contractId);
    const record = records.get(interaction.contractId);

    if (!interaction.verified) {
      unverifiableContracts.add(interaction.contractId);
      const deployer = record?.deployer ?? (interaction.deployedInEnvelope ? sourceAccount : undefined);
      if (!record?.deployer && !allowlist.has(interaction.contractId) && deployer === undefined) {
        unknownDeployers.add(interaction.contractId);
      }

      indicators.push({
        code: 'UNVERIFIED_CONTRACT_INVOCATION',
        category: 'contract',
        severity: 'high',
        weight: 24,
        title: `Envelope invokes unverified contract ${interaction.contractId}`,
        detail:
          `${interaction.contractId} has no verified trust record` +
          `${record?.wasmHash ? ' matching its audited WASM build' : ''} and was invoked ` +
          `${interaction.invocationCount} time(s) (${interaction.functions.join(', ') || 'function not supplied'}). ` +
          'Its behaviour cannot be established from the envelope alone.',
        remediation:
          'Require an audited source/WASM hash for this contract and register it before allowing the envelope through. If the contract is unknown, do not sign.',
        evidence: {
          contractId: interaction.contractId,
          invocationCount: interaction.invocationCount,
          functions: interaction.functions,
          registryRecordPresent: record !== undefined,
          operatorAllowlisted: allowlist.has(interaction.contractId),
        },
      });
    }

    if (interaction.codeHashMismatch) {
      codeHashMismatches.add(interaction.contractId);
      indicators.push({
        code: 'CONTRACT_CODE_HASH_MISMATCH',
        category: 'contract',
        severity: 'critical',
        weight: 38,
        title: `${interaction.contractId} no longer matches its verified WASM hash`,
        detail:
          `The trust registry verified ${interaction.contractId} against WASM hash ` +
          `${record?.wasmHash}, but the contract instance entry on-ledger now records ` +
          `${state?.wasmHash}. The deployed code is not what was audited.`,
        remediation:
          'Block execution and treat the contract as compromised. Only re-allow-list it after a fresh audit of the new WASM build, and confirm with the protocol whether an upgrade was announced.',
        evidence: {
          contractId: interaction.contractId,
          auditedHash: record?.wasmHash,
          onLedgerHash: state?.wasmHash,
        },
      });
    }

    if (state && state.deployed === false) {
      indicators.push({
        code: 'CONTRACT_NOT_DEPLOYED',
        category: 'contract',
        severity: 'high',
        weight: 20,
        title: `Envelope invokes ${interaction.contractId}, which has no live instance`,
        detail:
          `The pre-execution snapshot shows no deployed instance for ${interaction.contractId}. ` +
          'The call would revert — or, if the instance is created earlier in the same envelope, it is a ' +
          'deploy-and-execute in one transaction.',
        remediation:
          'Confirm the contract id is correct and deployed on the target network. An address that only resolves inside a single envelope is a red flag.',
        evidence: { contractId: interaction.contractId, deployed: false },
      });
    }

    if (state?.codeArchived === true) {
      indicators.push({
        code: 'INVOCATION_OF_ARCHIVED_CONTRACT',
        category: 'contract',
        severity: 'medium',
        weight: 12,
        title: `${interaction.contractId} has an archived WASM code entry`,
        detail:
          `The WASM code entry for ${interaction.contractId} has been evicted from live state. ` +
          'The invocation will fail until a RestoreFootprint operation brings it back.',
        remediation:
          'Restore the contract footprint (and budget the rent) before invoking, or invoke a different instance.',
        evidence: { contractId: interaction.contractId, codeArchived: true },
      });
    }
  }

  // ── Rule: deploy-and-invoke in a single envelope ─────────────────────────

  for (const [contractId, deployer] of deployedInEnvelope) {
    if (!interactionsByContract.has(contractId)) continue;
    const allowlisted = allowlist.has(contractId);
    const record = records.get(contractId);

    indicators.push({
      code: 'NEWLY_DEPLOYED_CONTRACT_INVOKED',
      category: 'contract',
      severity: allowlisted || record?.verified === true ? 'medium' : 'critical',
      weight: allowlisted || record?.verified === true ? 12 : 36,
      title: `Envelope deploys and then invokes ${contractId}`,
      detail:
        `${contractId} is created earlier in this same envelope by ${deployer} and then invoked. ` +
        'Code that appears and runs in a single transaction has never been published, indexed, or ' +
        'audited, and its behaviour is not observable before the transaction lands.',
      remediation:
        'Split deployment and invocation into separate, separately-reviewed transactions so the deployed contract is at least observable before anything calls it.',
      evidence: {
        contractId,
        deployer,
        operatorAllowlisted: allowlisted,
        registryVerified: record?.verified === true,
      },
    });

    if (!allowlisted && record?.verified !== true) {
      const selfDeployed = deployer === sourceAccount;
      indicators.push({
        code: 'UNVERIFIED_SELF_DEPLOYED_CONTRACT',
        category: 'contract',
        severity: 'critical',
        weight: 30,
        title: `Unverified contract ${contractId} deployed by the signing account itself`,
        detail:
          `The signing account ${sourceAccount} deploys ${contractId} in this envelope and ` +
          'immediately invokes it. A contract deployed and called by the same key in one transaction ' +
          'has no external review step at all — this is self-attested code executing with full authority.',
        remediation:
          'Reject. Deploy the contract in its own transaction, publish and audit the source, then invoke it from a separate submission.',
        evidence: { contractId, deployer, sourceAccount, selfDeployed },
      });
    }
  }

  // ── Rule: invocation fan-out ────────────────────────────────────────────

  for (const interaction of interactionsByContract.values()) {
    if (interaction.invocationCount < thresholds.maxInvocationsPerContract) continue;
    indicators.push({
      code: 'INVOCATION_FAN_OUT',
      category: 'contract',
      severity: 'medium',
      weight: 14,
      title: `Envelope invokes ${interaction.contractId} ${interaction.invocationCount} times`,
      detail:
        `${interaction.invocationCount} invocations of ${interaction.contractId} ` +
        `(${interaction.functions.join(', ')}) in one envelope. Repeated invocation of the same ` +
        'contract in one transaction is how looping-drain attacks multiply a single authorized call.',
      remediation:
        'Enumerate each invocation and its arguments. If the calls form a loop, the envelope is a drain mechanism regardless of what the contract is verified to do.',
      evidence: {
        contractId: interaction.contractId,
        invocationCount: interaction.invocationCount,
        functions: interaction.functions,
        threshold: thresholds.maxInvocationsPerContract,
      },
    });
  }

  const interactions = [...interactionsByContract.values()].sort((a, b) =>
    a.contractId.localeCompare(b.contractId),
  );

  const analysis: ContractInteractionAnalysis = {
    interactions,
    privilegedInvocations,
    unknownDeployers: [...unknownDeployers].sort(),
    codeHashMismatches: [...codeHashMismatches].sort(),
    unverifiableContracts: [...unverifiableContracts].sort(),
  };

  return { analysis, indicators };
}

/** True when the envelope touches at least one contract. */
export function hasContractInteractions(analysis: ContractInteractionAnalysis): boolean {
  return analysis.interactions.length > 0;
}

/**
 * Convenience predicate mirroring the "unknown deployer" concept for callers
 * that want to assert on the analyzer output without re-reading the analysis.
 */
export function hasUnknownDeployer(analysis: ContractInteractionAnalysis): boolean {
  return analysis.unknownDeployers.length > 0;
}

/** Exposed for reuse by wallet-side tooling that wants the same function list. */
export const PRIVILEGED_FUNCTIONS = PRIVILEGED_FUNCTION_NAMES;
