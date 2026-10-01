/**
 * Pre-execution simulation and threat-scoring engine for Stellar & Soroban
 * transaction envelopes.
 *
 * This is the analysis half of the `tx-simulation` module: it is a pure
 * function of its inputs — no network, no database, no clock — so it can be
 * exercised exhaustively by unit tests and reused by the HTTP service, a
 * future pre-flight CLI command, or an in-process screening step ahead of
 * dispatching an alert.
 *
 * ## Why pre-execution, and not another watcher
 *
 * Every other detector in this repository runs *after* a transaction is
 * finalized: the SSE watcher sees a payment, the Soroban indexer sees an
 * event, the multisig watcher sees a pending envelope. That is the wrong side
 * of the ledger for a threat engine — by the time a drain has been indexed,
 * the value has already moved. This module answers the question asked before
 * an envelope is signed: given the envelope the caller is about to submit,
 * and the footprint the RPC says that envelope touches, does this look like
 * someone emptying an account, smuggling writes past a declared footprint, or
 * reaching for a contract nobody vouched for?
 *
 * ## Three analysis surfaces, one score
 *
 *  1. **Footprint diff** (#47/#103 territory, but before submission rather
 *     than after). A Soroban envelope *declares* a footprint in its
 *     `sorobanData` extension, and the simulation RPC reports which ledger
 *     keys it actually *accessed*. A write outside the declared read-write set
 *     is the highest-signal indicator available: it means the transaction's
 *     own resource accounting did not cover what it does.
 *  2. **Drain patterns** (#105/#119 territory). Value-out shapes: sweeping an
 *     account to dust, fanning one envelope out to many recipients, revoking a
 *     trustline's authorization, and asymmetric path payments that convert a
 *     loose `sendMax` ceiling into a large guaranteed `destAmount`.
 *  3. **Unverified contract interactions** (#76/#115 territory). Every
 *     `invokeHostFunctionOp` is resolved back to a contract ID; IDs outside
 *     the caller's trusted set, contracts deployed by the same envelope, and
 *     runaway `extendFootprintTtl` calls are all reported.
 *
 * ## Deliberate honesty about limits
 *
 * - Static envelope analysis cannot see through contract logic. `trustedContracts`
 *   is a *caller-supplied* allow-list, so "unverified" here means "not vouched
 *   for in the request", never "provably malicious".
 * - Path-payment amounts are bounds, not exact transfers. The engine always
 *   measures the pessimistic side of the bound (`sendMax`) when asking how
 *   much leaves the account, and says so in the indicator evidence.
 * - Without a `ledgerBaseline` the engine cannot compute balance-relative
 *   drains, and without a `simulation` block it cannot diff a footprint. It
 *   does not guess: `SimulationReport.coverage` states exactly which surfaces
 *   were analyzable, and the corresponding indicators are absent rather than
 *   emitted optimistically.
 */

import * as StellarSdk from 'stellar-sdk';

/* ────────────────────────────── types ────────────────────────────── */

export type SimulationSeverity = 'critical' | 'high' | 'medium' | 'low';

export type SimulationIndicatorCategory =
  | 'footprint'
  | 'drain'
  | 'authorization'
  | 'contract'
  | 'resource';

export type SimulationRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/**
 * `allow` — nothing, or only low-severity indicators.
 * `review` — something a human should look at before signing.
 * `block`  — at least one critical indicator, or a saturated score.
 */
export type SimulationVerdict = 'allow' | 'review' | 'block';

export interface SimulationIndicator {
  /** Stable, machine-readable code a client can branch on. */
  code: string;
  category: SimulationIndicatorCategory;
  severity: SimulationSeverity;
  title: string;
  detail: string;
  /** Concrete, one-sentence "what to do about it". */
  remediation: string;
  /** Numbers/identifiers backing the finding; long lists are truncated. */
  evidence: Record<string, unknown>;
}

export interface SimulationRiskBreakdownEntry {
  category: SimulationIndicatorCategory;
  /** Sum of this category's indicator weights, capped at 100. */
  score: number;
  indicatorCodes: string[];
  indicatorCount: number;
  worstSeverity: SimulationSeverity | null;
}

export interface SimulationRiskAssessment {
  /** 0 (nothing found) to 100 (saturated). */
  score: number;
  level: SimulationRiskLevel;
  verdict: SimulationVerdict;
  indicators: SimulationIndicator[];
  breakdown: SimulationRiskBreakdownEntry[];
  /** De-duplicated remediations for the high/critical indicators, worst first. */
  recommendations: string[];
}

/** One leg that moves value *out of* an account. */
export interface SimulatedOutflow {
  kind: 'payment' | 'pathPaymentReceive' | 'pathPaymentSend' | 'accountMerge' | 'clawback';
  destination: string;
  /** `native`, or `CODE:ISSUER` for a credit asset. */
  asset: string;
  /**
   * Pessimistic upper bound on the amount debited, in stroops as a decimal
   * string. Exact for `payment`; a protocol-enforced ceiling for path
   * payments; `0` for `accountMerge`, whose size is by definition the whole
   * balance.
   */
  amountStroops: string;
  /** False when the leg debits a third party rather than the source account. */
  debitsSourceAccount: boolean;
  /** Path payments only: the amount the destination is guaranteed to receive. */
  destAmountStroops?: string;
}

export type SorobanHostFunctionKind = 'invokeContract' | 'createContract' | 'uploadContractWasm';

export interface DecodedContractInvocation {
  hostFunction: SorobanHostFunctionKind;
  /** Present for `invokeContract`; absent for the deploy/upload host functions. */
  contractId?: string;
  functionName?: string;
  /** Contract invocation: number of arguments. Upload: WASM size in bytes. */
  argumentCount: number;
}

export interface DeclaredFootprint {
  readOnly: string[];
  readWrite: string[];
}

export interface DecodedAuthorizationShape {
  /** `setTrustLineFlags` operations setting `authorized` to false. */
  trustLineAuthorizationRevocations: number;
  clawbackOperations: number;
  accountMergeOperations: number;
  /** `setOptions` adding (or re-arming) a master key signer. */
  grantsMasterKey: boolean;
  /** `setOptions` setting any of the low/med/high thresholds. */
  setsThresholds: boolean;
}

export interface DecodedTtlExtensions {
  operationCount: number;
  /** Largest `extendTo` ledger requested by any `extendFootprintTtl` op. */
  maxExtendToLedger: number;
  /** Count of protocol 23+ `restoreFootprint` ops in the envelope. */
  restoreFootprintOperationCount: number;
}

export interface DecodedEnvelope {
  networkPassphrase: string;
  isFeeBump: boolean;
  /**
   * Hash of the envelope as submitted, hex. For a fee-bump this is the *outer*
   * envelope hash, which is what the ledger indexes and what identifies the
   * submission for audit purposes.
   */
  txHash: string;
  /**
   * Hash of the inner transaction, hex. Equals `txHash` for a plain
   * transaction; differs for a fee-bump, whose inner fee bump is replaced by
   * the outer one.
   */
  innerTxHash: string;
  /** Base64 XDR exactly as submitted, for audit correlation. */
  envelopeXdr: string;
  sourceAccount: string;
  sequenceNumber: string;
  feeStroops: string;
  operationCount: number;
  signatureCount: number;
  hasTimeBounds: boolean;
  declaredFootprint: DeclaredFootprint;
  outflows: SimulatedOutflow[];
  contractInvocations: DecodedContractInvocation[];
  authorization: DecodedAuthorizationShape;
  ttlExtensions: DecodedTtlExtensions;
}

/**
 * The subset of a Soroban RPC `simulateTransaction` response this engine
 * consumes. Supplied by the caller rather than fetched here: the engine makes
 * no network calls, which is what keeps it deterministic and unit testable,
 * and lets a client reuse a simulation it already performed.
 */
export interface SimulationResultInput {
  status?: string;
  costCpuInsns?: string;
  costMemBytes?: string;
  readOnlyLedgerKeys?: string[];
  readWriteLedgerKeys?: string[];
  /** Keys the RPC reported as archived, needing a restore preamble. */
  archivedLedgerKeys?: string[];
  restoreRequired?: boolean;
}

/** Caller-supplied ledger facts. Without these, balance math is skipped. */
export interface LedgerBaselineInput {
  nativeBalanceStroops?: string;
  knownRecipients?: string[];
  trustedContracts?: string[];
}

export interface SimulationThresholds {
  /** Share of the baseline native balance one envelope may move out. */
  drainExhaustionRatio: number;
  /** Distinct recipients in one envelope before a fan-out is flagged. */
  drainSplitDestinationThreshold: number;
  /** Remaining stroops below which an account counts as "swept". */
  dustResidueStroops: bigint;
  /** `extendFootprintTtl` beyond this many ledgers (~30 days) is excessive. */
  ttlExtensionLedgerThreshold: number;
  /** Simulated CPU instruction count above which a run looks pathological. */
  cpuInstructionThreshold: bigint;
  /** Accessed footprint entries above which a run is worth a look. */
  maxFootprintEntries: number;
  /** `destAmount / sendAmount` beyond which a path payment is asymmetric. */
  pathPaymentAsymmetryRatio: number;
  /** Accessed-over-declared footprint multiplier that counts as expansion. */
  footprintExpansionRatio: number;
}

export type SimulationOptions = Partial<SimulationThresholds>;

export interface SimulationInput {
  envelopeXdr: string;
  networkPassphrase: string;
  simulation?: SimulationResultInput | null;
  ledgerBaseline?: LedgerBaselineInput | null;
  options?: SimulationOptions;
}

export interface FootprintDiff {
  declaredReadOnly: string[];
  declaredReadWrite: string[];
  accessedReadOnly: string[];
  accessedReadWrite: string[];
  /** Accessed for writing but never declared read-write. Highest-signal set. */
  undeclaredReadWrite: string[];
  /** Accessed for reading but never declared at all. */
  undeclaredReadOnly: string[];
  /** Declared read-write, but the simulation only ever read it. */
  readWriteOverlap: string[];
  /** Declared read-write, but the simulation never touched it. */
  unusedReadWrite: string[];
  archivedEntries: string[];
  declaredCount: number;
  accessedCount: number;
  /** accessedCount / max(declaredCount, 1), rounded to 2 decimals. */
  accessExpansionRatio: number;
}

export interface SimulationCoverage {
  /** True when a `simulation` block was supplied and a diff was produced. */
  footprintDiff: boolean;
  /** True when a native balance was supplied for balance-relative analysis. */
  balanceBaseline: boolean;
  /** True when a non-empty trusted-contract allow-list was supplied. */
  trustedContractBaseline: boolean;
  /** True when a non-empty known-recipient allow-list was supplied. */
  recipientBaseline: boolean;
}

export interface SimulationReport {
  envelope: DecodedEnvelope;
  footprintDiff: FootprintDiff | null;
  risk: SimulationRiskAssessment;
  coverage: SimulationCoverage;
}

/* ──────────────────────────── constants ──────────────────────────── */

const STROOPS_PER_UNIT = 10_000_000;
const NATIVE_ASSET = 'native';

/**
 * Severity → score contribution. Identical to `utils/wasm-analyzer.ts`'s
 * weighting so a "critical" carries the same magnitude to a client that has
 * already seen a WASM analysis, and so the two engines can be tuned together.
 */
export const SEVERITY_WEIGHTS: Record<SimulationSeverity, number> = {
  critical: 40,
  high: 25,
  medium: 12,
  low: 5,
};

/** Ordering used for "worst first" recommendations and `worstSeverity`. */
const SEVERITY_ORDER: SimulationSeverity[] = ['critical', 'high', 'medium', 'low'];

const CATEGORY_ORDER: SimulationIndicatorCategory[] = [
  'footprint',
  'drain',
  'authorization',
  'contract',
  'resource',
];

/**
 * Lower bounds of each risk level, set equal to the corresponding severity
 * weight. A single indicator therefore always reports at its own severity
 * rather than a band below it — the alternative (floors above the weights)
 * silently downgrades a lone `high` finding to "medium", which understates
 * exactly the findings a reviewer most needs to see.
 */
export const RISK_LEVEL_FLOORS = {
  low: SEVERITY_WEIGHTS.low,
  medium: SEVERITY_WEIGHTS.medium,
  high: SEVERITY_WEIGHTS.high,
  critical: SEVERITY_WEIGHTS.critical,
} as const;

export const DEFAULT_SIMULATION_THRESHOLDS: SimulationThresholds = {
  drainExhaustionRatio: 0.9,
  drainSplitDestinationThreshold: 3,
  dustResidueStroops: 100_000n,
  ttlExtensionLedgerThreshold: 535,
  cpuInstructionThreshold: 100_000_000n,
  maxFootprintEntries: 100,
  pathPaymentAsymmetryRatio: 100,
  footprintExpansionRatio: 2,
};

/**
 * Evidence lists are user-visible and are echoed into an audit row, so they
 * are capped. The `truncated`/`total` fields let a reader tell a sample from
 * a complete list.
 */
export const MAX_EVIDENCE_ITEMS = 10;

// XDR union discriminants in this protocol version. Read through
// `switchArm()` rather than compared against generated enum objects, because
// the generated unions disagree about how `switch()` reports its arm.
const OPERATION_BODY_INVOKE_HOST_FUNCTION = 24;
const OPERATION_BODY_EXTEND_FOOTPRINT_TTL = 25;
const OPERATION_BODY_RESTORE_FOOTPRINT = 26;
const HOST_FUNCTION_INVOKE_CONTRACT = 0;
const HOST_FUNCTION_CREATE_CONTRACT = 1;
const HOST_FUNCTION_UPLOAD_CONTRACT_WASM = 2;
const HOST_FUNCTION_CREATE_CONTRACT_V2 = 3;
const TRANSACTION_EXT_SOROBAN_DATA = 1;

/* ──────────────────────────── helpers ───────────────────────────── */

/**
 * `xdr.Union.switch()` is not uniform across the generated types in this
 * stellar-sdk build: some unions return a raw number, others an enum wrapper.
 * Normalize both to a number so callers never have to care.
 */
function switchArm(value: { switch(): unknown }): number {
  const sw = value.switch() as unknown;
  if (typeof sw === 'number') return sw;
  const inner = (sw as { value?: unknown } | null)?.value;
  if (typeof inner === 'number') return inner;
  return -1;
}

/**
 * Parses a Stellar decimal amount into stroops without losing precision on
 * large values (a max-supply SAC balance does not fit a `number`). Malformed
 * input yields `0n` rather than letting `NaN` poison every downstream sum.
 */
export function toStroops(amount: string | number | undefined | null): bigint {
  if (amount === undefined || amount === null) return 0n;
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
  const [whole, fraction = ''] = trimmed.split('.');
  const padded = (fraction + '0000000').slice(0, 7);
  return BigInt(whole) * BigInt(STROOPS_PER_UNIT) + BigInt(padded || '0');
}

/** Parses an unsigned integer string; anything else becomes `0n`. */
export function toUnsignedBigInt(value: string | number | undefined | null): bigint {
  if (value === undefined || value === null) return 0n;
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) return 0n;
  return BigInt(trimmed);
}

function normalizeAsset(asset: unknown): string {
  if (asset === undefined || asset === null) return NATIVE_ASSET;
  const asString = String(asset);
  return asString.length > 0 ? asString : NATIVE_ASSET;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sortedCopy(values: string[]): string[] {
  return uniq(values).sort();
}

function difference(left: Iterable<string>, right: Iterable<string>): string[] {
  const rightSet = new Set(right);
  return uniq(Array.from(left)).filter((v) => !rightSet.has(v));
}

function intersection(left: Iterable<string>, right: Iterable<string>): string[] {
  const rightSet = new Set(right);
  return uniq(Array.from(left)).filter((v) => rightSet.has(v));
}

function evidenceList(values: string[]): {
  sample: string[];
  total: number;
  truncated: boolean;
} {
  const unique = sortedCopy(values);
  return {
    sample: unique.slice(0, MAX_EVIDENCE_ITEMS),
    total: unique.length,
    truncated: unique.length > MAX_EVIDENCE_ITEMS,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampPositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/* ───────────────────────── envelope decoding ────────────────────── */

/**
 * Resolves the invoked contract ID from an `InvokeContractArgs` struct.
 * Returns `null` for a non-contract `ScAddress` (an account), which the
 * caller reports as an unrecognized interaction rather than a contract hit.
 */
function decodeScAddressContractId(address: unknown): string | null {
  try {
    const parsed = StellarSdk.Address.fromScAddress(address as never);
    return StellarSdk.StrKey.encodeContract(parsed.toBuffer());
  } catch {
    return null;
  }
}

/**
 * Shape of an `xdr.Operation`. The arm accessors live on the *body* union, not
 * on the operation itself — `xdr.Operation` is only `{sourceAccount, body}`.
 */
interface RawSorobanOperation {
  body(): {
    switch(): unknown;
    invokeHostFunctionOp?: () => {
      hostFunction(): { switch(): unknown; value(): unknown };
    };
    extendFootprintTtlOp?: () => { extendTo(): number };
    restoreFootprintOp?: () => unknown;
  };
}

function decodeHostFunction(
  invokeHostFunctionOp: { hostFunction(): { switch(): unknown; value(): unknown } },
): DecodedContractInvocation | null {
  try {
    const hostFunction = invokeHostFunctionOp.hostFunction();
    switch (switchArm(hostFunction)) {
      case HOST_FUNCTION_INVOKE_CONTRACT: {
        const args = hostFunction.value() as {
          contractAddress(): unknown;
          functionName(): { toString(): string };
          args(): unknown[];
        };
        return {
          hostFunction: 'invokeContract',
          contractId: decodeScAddressContractId(args.contractAddress()) ?? undefined,
          functionName: args.functionName().toString(),
          argumentCount: args.args().length,
        };
      }
      case HOST_FUNCTION_CREATE_CONTRACT:
      case HOST_FUNCTION_CREATE_CONTRACT_V2:
        return { hostFunction: 'createContract', argumentCount: 0 };
      case HOST_FUNCTION_UPLOAD_CONTRACT_WASM: {
        const wasm = hostFunction.value() as Uint8Array | null;
        return { hostFunction: 'uploadContractWasm', argumentCount: wasm?.length ?? 0 };
      }
      default:
        return null;
    }
  } catch {
    // A host-function shape this SDK build does not model is not itself a
    // risk signal; the operation is simply left unreported rather than
    // causing the whole analysis to fail.
    return null;
  }
}

type ParsedClassicOperation = Record<string, unknown> & { type?: string };

function collectClassicOutflows(
  operations: ParsedClassicOperation[],
  sourceAccount: string,
): SimulatedOutflow[] {
  const outflows: SimulatedOutflow[] = [];

  for (const op of operations) {
    switch (op.type) {
      case 'payment':
        outflows.push({
          kind: 'payment',
          destination: String(op.destination ?? ''),
          asset: normalizeAsset(op.asset),
          amountStroops: toStroops(op.amount as string).toString(),
          debitsSourceAccount: true,
        });
        break;
      case 'pathPaymentStrictReceive':
        // `sendMax` is a protocol-enforced ceiling, not an exact debit.
        outflows.push({
          kind: 'pathPaymentReceive',
          destination: String(op.destination ?? ''),
          asset: normalizeAsset(op.sendAsset),
          amountStroops: toStroops(op.sendMax as string).toString(),
          destAmountStroops: toStroops(op.destAmount as string).toString(),
          debitsSourceAccount: true,
        });
        break;
      case 'pathPaymentStrictSend':
        outflows.push({
          kind: 'pathPaymentSend',
          destination: String(op.destination ?? ''),
          asset: normalizeAsset(op.sendAsset),
          amountStroops: toStroops(op.sendAmount as string).toString(),
          destAmountStroops: toStroops(op.destMin as string).toString(),
          debitsSourceAccount: true,
        });
        break;
      case 'accountMerge':
        // A merge sweeps the whole native balance plus every trustline, so
        // its size is the balance itself — recorded as 0 stroops and handled
        // by the accountMerge indicator rather than by balance math.
        outflows.push({
          kind: 'accountMerge',
          destination: String(op.destination ?? ''),
          asset: NATIVE_ASSET,
          amountStroops: '0',
          debitsSourceAccount: true,
        });
        break;
      case 'clawback': {
        const from = String(op.from ?? '');
        outflows.push({
          kind: 'clawback',
          destination: from,
          asset: normalizeAsset(op.asset),
          amountStroops: toStroops(op.amount as string).toString(),
          debitsSourceAccount: from === sourceAccount,
        });
        break;
      }
      default:
        break;
    }
  }

  return outflows;
}

function readAuthorizationShape(
  operations: ParsedClassicOperation[],
): DecodedAuthorizationShape {
  let trustLineAuthorizationRevocations = 0;
  let clawbackOperations = 0;
  let accountMergeOperations = 0;
  let grantsMasterKey = false;
  let setsThresholds = false;

  for (const op of operations) {
    switch (op.type) {
      case 'setTrustLineFlags': {
        const flags = (op.flags ?? {}) as { authorized?: boolean };
        if (flags.authorized === false) {
          trustLineAuthorizationRevocations++;
        }
        break;
      }
      case 'clawback':
        clawbackOperations++;
        break;
      case 'accountMerge':
        accountMergeOperations++;
        break;
      case 'setOptions': {
        // `masterWeight` is only present when the op sets a master key
        // weight; 0 clears it, anything >= 1 re-arms it.
        if (typeof op.masterWeight === 'number' && op.masterWeight >= 1) {
          grantsMasterKey = true;
        }
        const thresholds = ['lowThreshold', 'medThreshold', 'highThreshold'] as const;
        for (const key of thresholds) {
          if (typeof op[key] === 'number') {
            setsThresholds = true;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    trustLineAuthorizationRevocations,
    clawbackOperations,
    accountMergeOperations,
    grantsMasterKey,
    setsThresholds,
  };
}

/**
 * Decodes a base64 transaction envelope into the normalized shape the
 * detectors consume.
 *
 * Fee-bump envelopes are unwrapped to their inner transaction and flagged:
 * the fee bump is a fee/sponsorship concern, and scoring it as an operation of
 * its own would double-count the inner envelope's real behaviour.
 *
 * Throws for XDR that cannot be decoded at all — callers turn that into a
 * client-visible validation error rather than a false "clean" report.
 */
export function decodeEnvelope(
  envelopeXdr: string,
  networkPassphrase: string,
): DecodedEnvelope {
  const parsed = StellarSdk.TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  const isFeeBump = 'innerTransaction' in parsed;
  const inner = isFeeBump ? parsed.innerTransaction : parsed;

  const rawTx = inner.toEnvelope().v1().tx();

  // Soroban operations are read from the raw XDR: the parsed
  // `invokeHostFunction` operation exposes its host function as an opaque XDR
  // union with no arm accessors in this SDK build.
  const contractInvocations: DecodedContractInvocation[] = [];
  let ttlExtensionOperationCount = 0;
  let maxExtendToLedger = 0;
  let restoreFootprintOperationCount = 0;

  for (const rawOp of rawTx.operations() as RawSorobanOperation[]) {
    const body = rawOp.body();
    const arm = switchArm(body);
    if (arm === OPERATION_BODY_INVOKE_HOST_FUNCTION && body.invokeHostFunctionOp) {
      const decoded = decodeHostFunction(body.invokeHostFunctionOp());
      if (decoded) {
        contractInvocations.push(decoded);
      }
    }
    if (arm === OPERATION_BODY_EXTEND_FOOTPRINT_TTL && body.extendFootprintTtlOp) {
      const extendTo = body.extendFootprintTtlOp().extendTo();
      ttlExtensionOperationCount++;
      if (extendTo > maxExtendToLedger) {
        maxExtendToLedger = extendTo;
      }
    }
    if (arm === OPERATION_BODY_RESTORE_FOOTPRINT) {
      // Protocol 23+ `restoreFootprint` revives *every* archived entry the
      // simulation touched, not a caller-chosen subset. The archive entries
      // themselves come from the simulation, so the count is filled in there.
      restoreFootprintOperationCount++;
    }
  }

  const declaredFootprint: DeclaredFootprint = { readOnly: [], readWrite: [] };
  const ext = rawTx.ext();
  if (switchArm(ext) === TRANSACTION_EXT_SOROBAN_DATA && ext.sorobanData) {
    try {
      const sorobanData = ext.sorobanData() as {
        resources(): {
          footprint(): {
            readOnly(): Array<{ toXDR(encoding: string): string }>;
            readWrite(): Array<{ toXDR(encoding: string): string }>;
          };
        };
      };
      const footprint = sorobanData.resources().footprint();
      declaredFootprint.readOnly = footprint.readOnly().map((k) => k.toXDR('base64'));
      declaredFootprint.readWrite = footprint.readWrite().map((k) => k.toXDR('base64'));
    } catch {
      // A footprint we cannot read is recorded as "nothing declared", which
      // makes the diff report every accessed key as undeclared — the
      // conservative direction, not the convenient one.
    }
  }

  const operations = inner.operations as unknown as ParsedClassicOperation[];

  return {
    networkPassphrase,
    isFeeBump,
    // The outer envelope hash is what the network records and what a wallet
    // signs off on, so it is the identity used for audit correlation. The inner
    // transaction hash differs and is recoverable by re-decoding the XDR.
    txHash: parsed.hash().toString('hex'),
    innerTxHash: inner.hash().toString('hex'),
    envelopeXdr,
    sourceAccount: inner.source,
    sequenceNumber: inner.sequence,
    feeStroops: inner.fee,
    operationCount: operations.length,
    signatureCount: inner.signatures.length,
    hasTimeBounds: inner.timeBounds !== undefined,
    declaredFootprint,
    outflows: collectClassicOutflows(operations, inner.source),
    contractInvocations,
    authorization: readAuthorizationShape(operations),
    ttlExtensions: {
      operationCount: ttlExtensionOperationCount,
      maxExtendToLedger,
      restoreFootprintOperationCount,
    },
  };
}

/* ──────────────────────── footprint diffing ─────────────────────── */

/**
 * Compares the footprint an envelope *declares* against the ledger keys a
 * simulation says it actually *accessed*.
 *
 * Every set is de-duplicated and sorted so two runs over the same envelope
 * produce byte-identical output — the result is persisted as an audit row and
 * compared by clients between runs.
 */
export function computeFootprintDiff(
  declared: DeclaredFootprint,
  accessed: { readOnly: string[]; readWrite: string[]; archived?: string[] },
): FootprintDiff {
  const declaredReadOnly = sortedCopy(declared.readOnly);
  const declaredReadWrite = sortedCopy(declared.readWrite);
  const accessedReadOnly = sortedCopy(accessed.readOnly);
  const accessedReadWrite = sortedCopy(accessed.readWrite);

  const declaredAll: Set<string> = new Set([...declaredReadOnly, ...declaredReadWrite]);
  const accessedAll: Set<string> = new Set([...accessedReadOnly, ...accessedReadWrite]);

  const declaredCount = declaredAll.size;
  const accessedCount = accessedAll.size;

  return {
    declaredReadOnly,
    declaredReadWrite,
    accessedReadOnly,
    accessedReadWrite,
    undeclaredReadWrite: difference(accessedReadWrite, declaredReadWrite),
    undeclaredReadOnly: difference(accessedReadOnly, declaredAll),
    readWriteOverlap: intersection(declaredReadWrite, accessedReadOnly),
    unusedReadWrite: difference(declaredReadWrite, accessedAll),
    archivedEntries: sortedCopy(accessed.archived ?? []),
    declaredCount,
    accessedCount,
    accessExpansionRatio: round2(accessedCount / Math.max(declaredCount, 1)),
  };
}

/* ───────────────────────── indicator builder ───────────────────── */

function indicator(
  code: string,
  category: SimulationIndicatorCategory,
  severity: SimulationSeverity,
  title: string,
  detail: string,
  remediation: string,
  evidence: Record<string, unknown>,
): SimulationIndicator {
  return { code, category, severity, title, detail, remediation, evidence };
}

/**
 * Footprint-shape indicators. Only emitted when a simulation block was
 * supplied — without the accessed set there is no diff to reason about, and
 * guessing would be worse than silence.
 */
export function detectFootprintIndicators(
  diff: FootprintDiff,
  simulation: SimulationResultInput | undefined,
  thresholds: SimulationThresholds,
): SimulationIndicator[] {
  const indicators: SimulationIndicator[] = [];

  if (diff.undeclaredReadWrite.length > 0) {
    indicators.push(
      indicator(
        'FOOTPRINT_UNDECLARED_WRITE',
        'footprint',
        'critical',
        'Writes ledger keys the envelope never declared',
        `The simulation touched ${diff.undeclaredReadWrite.length} ledger key(s) for writing that were absent from the envelope's declared read-write footprint. A Soroban transaction cannot write outside the footprint it declared, so this means the simulation and the signed envelope disagree — a different envelope was simulated, or the footprint was set by hand.`,
        'Do not submit this envelope. Re-run simulateTransaction on the exact envelope being signed and rebuild it with rpc.assembleTransaction.',
        {
          undeclaredReadWrite: evidenceList(diff.undeclaredReadWrite),
          declaredCount: diff.declaredCount,
          accessedCount: diff.accessedCount,
        },
      ),
    );
  }

  if (diff.undeclaredReadOnly.length > 0) {
    indicators.push(
      indicator(
        'FOOTPRINT_UNDECLARED_READ',
        'footprint',
        'medium',
        'Reads ledger keys outside the declared footprint',
        `${diff.undeclaredReadOnly.length} ledger key(s) were read but declared nowhere in the footprint. The resource fee was therefore not computed for them.`,
        'Re-simulate the exact envelope and re-assemble it so the footprint matches the observed access set.',
        { undeclaredReadOnly: evidenceList(diff.undeclaredReadOnly) },
      ),
    );
  }

  if (diff.readWriteOverlap.length > 0) {
    indicators.push(
      indicator(
        'FOOTPRINT_READ_WRITE_OVERLAP',
        'footprint',
        'medium',
        'Declares read-write keys it only reads',
        `${diff.readWriteOverlap.length} key(s) were declared read-write but only ever read. Every declared write entry is billed rent and widens the blast radius if the envelope is ever replayed.`,
        'Declare these keys read-only; rpc.assembleTransaction produces the correct set from a fresh simulation.',
        { readWriteOverlap: evidenceList(diff.readWriteOverlap) },
      ),
    );
  }

  if (diff.unusedReadWrite.length > 0) {
    indicators.push(
      indicator(
        'FOOTPRINT_UNUSED_WRITE',
        'footprint',
        'low',
        'Declares read-write keys it never touches',
        `${diff.unusedReadWrite.length} declared read-write key(s) were never accessed. Harmless in itself, but each one is still declared writable for the duration of the transaction.`,
        'Refresh the footprint from a new simulation to keep the write set minimal.',
        { unusedReadWrite: evidenceList(diff.unusedReadWrite) },
      ),
    );
  }

  if (
    diff.declaredCount > 0 &&
    diff.undeclaredReadWrite.length === 0 &&
    diff.accessExpansionRatio > thresholds.footprintExpansionRatio
  ) {
    indicators.push(
      indicator(
        'FOOTPRINT_ACCESS_EXPANSION',
        'footprint',
        'high',
        'Accesses far more ledger entries than it declared',
        `The simulation accessed ${diff.accessedCount} ledger key(s) against a declared footprint of ${diff.declaredCount} (${diff.accessExpansionRatio}x). Broad footprint access is how a legitimate-looking call reaches state belonging to unrelated accounts or pools.`,
        'Inspect the contract entry points this envelope calls and confirm each one should be touching this many ledger entries.',
        {
          accessedCount: diff.accessedCount,
          declaredCount: diff.declaredCount,
          accessExpansionRatio: diff.accessExpansionRatio,
          threshold: thresholds.footprintExpansionRatio,
        },
      ),
    );
  }

  if (diff.archivedEntries.length > 0) {
    indicators.push(
      indicator(
        'FOOTPRINT_ARCHIVE_RESURRECTION',
        'footprint',
        'medium',
        'Resurrects archived ledger entries',
        `${diff.archivedEntries.length} accessed key(s) are archived entries needing a restore preamble. Restoration charges rent and rewrites ledger state for entries nobody expected this transaction to touch.`,
        'Confirm the transaction genuinely needs these entries, and prefer leaving archived entries untouched over restoring them.',
        { archivedEntries: evidenceList(diff.archivedEntries) },
      ),
    );
  }

  if (simulation?.restoreRequired) {
    indicators.push(
      indicator(
        'FOOTPRINT_RESTORE_REQUIRED',
        'footprint',
        'medium',
        'Simulation requires an archive restore preamble',
        'The RPC returned a restore preamble instead of a final simulation, so the transaction cannot run until the archived entries it needs are restored in a separate transaction.',
        'Run the restore preamble as its own reviewed transaction before submitting this envelope.',
        { restoreRequired: true },
      ),
    );
  }

  return indicators;
}

/**
 * Balance- and shape-based drain indicators.
 *
 * Every indicator here is conditional on the caller having supplied the
 * baseline it needs; without one the corresponding finding is absent rather
 * than defaulted, so a report can never imply a check ran that did not.
 */
export function detectDrainIndicators(
  decoded: DecodedEnvelope,
  baseline: LedgerBaselineInput | null | undefined,
  thresholds: SimulationThresholds,
): SimulationIndicator[] {
  const indicators: SimulationIndicator[] = [];

  const nativeOutflowStroops = decoded.outflows
    .filter((o) => o.debitsSourceAccount && o.asset === NATIVE_ASSET)
    .reduce((sum, o) => sum + toUnsignedBigInt(o.amountStroops), 0n);

  const baselineBalance = baseline?.nativeBalanceStroops
    ? toUnsignedBigInt(baseline.nativeBalanceStroops)
    : null;

  const destinations = uniq(
    decoded.outflows
      .filter((o) => o.debitsSourceAccount)
      .map((o) => o.destination)
      .filter((d) => d.length > 0),
  );

  if (baselineBalance !== null && baselineBalance > 0n && nativeOutflowStroops > 0n) {
    const ratio = Number(nativeOutflowStroops) / Number(baselineBalance);
    const residue = baselineBalance - nativeOutflowStroops;

    if (ratio >= thresholds.drainExhaustionRatio) {
      indicators.push(
        indicator(
          'DRAIN_BALANCE_EXHAUSTION',
          'drain',
          'critical',
          'Moves essentially the entire native balance out of the account',
          `This envelope debits at most ${nativeOutflowStroops} stroops of native asset from the source account, ${round2(ratio * 100)}% of the supplied baseline balance of ${baselineBalance} stroops. Path-payment legs are counted at their protocol ceiling, so the real figure can only be higher.`,
          'Verify the destination is an account you control and that this transfer was the intended one. Do not sign an envelope that empties the account.',
          {
            outflowStroops: nativeOutflowStroops.toString(),
            baselineBalanceStroops: baselineBalance.toString(),
            ratio: round2(ratio),
            threshold: thresholds.drainExhaustionRatio,
          },
        ),
      );
    }

    if (residue >= 0n && residue < thresholds.dustResidueStroops) {
      indicators.push(
        indicator(
          'DRAIN_DUST_RESIDUE',
          'drain',
          'high',
          'Sweeps the account down to dust',
          `After this envelope the account would hold at most ${residue} stroops. Sweeping to a dust balance is the last leg of a drain: the account cannot pay for anything afterwards, so recovering costs real money.`,
          'Confirm the transfer amount is not a unit or rounding error, and keep a working balance in the account.',
          {
            residueStroops: residue.toString(),
            dustThresholdStroops: thresholds.dustResidueStroops.toString(),
          },
        ),
      );
    }
  }

  if (destinations.length >= thresholds.drainSplitDestinationThreshold) {
    indicators.push(
      indicator(
        'DRAIN_MULTI_DESTINATION_SPLIT',
        'drain',
        'high',
        'Splits one envelope across many recipients',
        `This envelope pays ${destinations.length} distinct recipients, at or above the fan-out threshold of ${thresholds.drainSplitDestinationThreshold}. One transaction splitting value across many accounts is the standard shape of both a distribution and a multi-hop laundering step.`,
        'Confirm every recipient is intended. Splitting across several accounts from a single envelope is worth a second look every time.',
        {
          recipientCount: destinations.length,
          threshold: thresholds.drainSplitDestinationThreshold,
          destinations: evidenceList(destinations),
        },
      ),
    );
  }

  const knownRecipients = baseline?.knownRecipients ?? [];
  if (knownRecipients.length > 0 && destinations.length > 0) {
    const unknownRecipients = destinations.filter((d) => !knownRecipients.includes(d));
    if (unknownRecipients.length > 0) {
      indicators.push(
        indicator(
          'DRAIN_UNKNOWN_RECIPIENT',
          'drain',
          'medium',
          'Pays recipients outside the caller-known set',
          `${unknownRecipients.length} recipient(s) are not in the supplied known-recipient allow-list. A first-time destination is normal, and is also exactly what a redirection looks like.`,
          'Confirm the destination addresses belong to you, and add recurring counterparties to the known-recipient set.',
          {
            unknownRecipients: evidenceList(unknownRecipients),
            knownRecipientCount: knownRecipients.length,
          },
        ),
      );
    }
  }

  const asymmetric = decoded.outflows.filter((o) => {
    if (!o.debitsSourceAccount || o.destAmountStroops === undefined) return false;
    const sendAmount = toUnsignedBigInt(o.amountStroops);
    const destAmount = toUnsignedBigInt(o.destAmountStroops);
    return (
      sendAmount > 0n &&
      destAmount > sendAmount &&
      Number(destAmount) / Number(sendAmount) >= thresholds.pathPaymentAsymmetryRatio
    );
  });
  if (asymmetric.length > 0) {
    indicators.push(
      indicator(
        'DRAIN_ASYMMETRIC_PATH_PAYMENT',
        'drain',
        'high',
        'Path payment guarantees far more output than its ceiling allows as input',
        `${asymmetric.length} path payment(s) guarantee an output at least ${thresholds.pathPaymentAsymmetryRatio}x larger than the protocol's own ceiling on the debit. The real debit is unknowable from the envelope, so the transaction cannot be priced before submission — the shape used for rounding extraction.`,
        'Re-price the path immediately before submitting and confirm the route. A loose send ceiling with a large guaranteed output should never be signed blind.',
        {
          count: asymmetric.length,
          ratioThreshold: thresholds.pathPaymentAsymmetryRatio,
          legs: asymmetric.slice(0, MAX_EVIDENCE_ITEMS).map((o) => ({
            destination: o.destination,
            amountStroops: o.amountStroops,
            destAmountStroops: o.destAmountStroops,
          })),
        },
      ),
    );
  }

  if (decoded.authorization.accountMergeOperations > 0) {
    indicators.push(
      indicator(
        'DRAIN_ACCOUNT_MERGE',
        'drain',
        'high',
        'Merges the source account away',
        `The envelope contains ${decoded.authorization.accountMergeOperations} accountMerge operation(s). A merge transfers the source account's entire native balance and every trustline, then deletes the account — unrecoverable once it lands.`,
        'Only merge an account you have finished with, and never inside an envelope that also invokes a contract.',
        { accountMergeOperations: decoded.authorization.accountMergeOperations },
      ),
    );
  }

  if (decoded.authorization.trustLineAuthorizationRevocations > 0) {
    indicators.push(
      indicator(
        'DRAIN_TRUSTLINE_AUTHORIZATION_REVOKED',
        'drain',
        'high',
        'Revokes a holder’s trustline authorization',
        `${decoded.authorization.trustLineAuthorizationRevocations} setTrustLineFlags operation(s) set authorized to false. Revoking authorization freezes the holder's balance and hands the issuer unilateral ability to claw it back — the standard prelude to a clawback.`,
        'Confirm the revocation was intended and communicated to the holder beforehand.',
        { revocations: decoded.authorization.trustLineAuthorizationRevocations },
      ),
    );
  }

  if (decoded.authorization.clawbackOperations > 0) {
    indicators.push(
      indicator(
        'DRAIN_CLAWBACK',
        'drain',
        'medium',
        'Claws back balances from a holder',
        `${decoded.authorization.clawbackOperations} clawback operation(s) move assets out of an account that did not authorise the transfer.`,
        'Confirm the issuer is entitled to claw these balances back and that holders were notified.',
        { clawbackOperations: decoded.authorization.clawbackOperations },
      ),
    );
  }

  return indicators;
}

/**
 * Account-control indicators. Kept separate from drain analysis because the
 * consequence is different in kind: these do not move value now, they make
 * the account movable later.
 */
export function detectAuthorizationIndicators(decoded: DecodedEnvelope): SimulationIndicator[] {
  const indicators: SimulationIndicator[] = [];

  if (decoded.authorization.grantsMasterKey) {
    indicators.push(
      indicator(
        'AUTH_MASTER_KEY_GRANT',
        'authorization',
        'critical',
        'Grants a master key signer',
        'A setOptions operation sets a master key weight of 1 or more. A master key controls an account unconditionally — it is not bound by any threshold, so a single leaked master key means total, irreversible loss of the account with no recovery path.',
        'Remove the master key weight from the envelope. Stellar accounts should be governed by threshold signers only.',
        { grantsMasterKey: true },
      ),
    );
  }

  if (decoded.authorization.setsThresholds) {
    indicators.push(
      indicator(
        'AUTH_THRESHOLD_CHANGE',
        'authorization',
        'medium',
        'Changes an account signing threshold',
        'A setOptions operation touches the low, medium or high threshold. Every future operation on the account then needs a different number of signatures, which quietly weakens or breaks multi-signature control that was set up deliberately.',
        'Confirm the threshold change is intended, and re-verify the signer set after it lands.',
        { setsThresholds: true },
      ),
    );
  }

  return indicators;
}

/** Contract-interaction indicators — the "unverified" half of the scope. */
export function detectContractIndicators(
  decoded: DecodedEnvelope,
  baseline: LedgerBaselineInput | null | undefined,
  thresholds: SimulationThresholds,
): SimulationIndicator[] {
  const indicators: SimulationIndicator[] = [];

  const invokedContractIds = uniq(
    decoded.contractInvocations
      .filter((c) => c.hostFunction === 'invokeContract' && c.contractId)
      .map((c) => c.contractId as string),
  );

  const trustedContracts = baseline?.trustedContracts ?? [];
  if (trustedContracts.length > 0 && invokedContractIds.length > 0) {
    const untrusted = invokedContractIds.filter((id) => !trustedContracts.includes(id));
    if (untrusted.length > 0) {
      indicators.push(
        indicator(
          'CONTRACT_UNVERIFIED_INTERACTION',
          'contract',
          'high',
          'Invokes contracts outside the trusted set',
          `${untrusted.length} invoked contract(s) are not in the supplied trusted-contract allow-list. "Unverified" here means nobody vouched for them in the request — not that they are malicious — but this is where an unverified interaction should be stopped.`,
          'Confirm each contract ID against its WASM hash and deployer before signing, and add contracts you have vetted to the trusted set.',
          {
            untrustedContracts: evidenceList(untrusted),
            trustedContractCount: trustedContracts.length,
          },
        ),
      );
    }
  }

  if (invokedContractIds.length >= 2) {
    indicators.push(
      indicator(
        'CONTRACT_COMPOSITION_MULTIPLE',
        'contract',
        'medium',
        'Invokes several distinct contracts in one envelope',
        `The envelope calls ${invokedContractIds.length} distinct contracts. Composability is the point of Soroban, but a multi-contract call is also how a benign entry point is used as a trampoline into an unvetted one.`,
        'Confirm every contract in the call graph is expected for this operation, not just the first one.',
        {
          contractCount: invokedContractIds.length,
          contractIds: evidenceList(invokedContractIds),
        },
      ),
    );
  }

  const deployHosts = decoded.contractInvocations.filter(
    (c) => c.hostFunction !== 'invokeContract',
  );
  if (deployHosts.length > 0) {
    indicators.push(
      indicator(
        'CONTRACT_UNVERIFIED_DEPLOYMENT',
        'contract',
        'high',
        'Deploys or uploads contract code in the same envelope',
        `The envelope contains ${deployHosts.length} contract deployment host function(s). Code deployed by the same transaction that moves value is code nobody has had the chance to audit or allow-list beforehand.`,
        'Split deployment and use into separate transactions so the code is reviewable before anything is transferred to it.',
        {
          hostFunctions: deployHosts.map((h) => h.hostFunction),
          wasmBytes: deployHosts
            .filter((h) => h.hostFunction === 'uploadContractWasm')
            .map((h) => h.argumentCount),
        },
      ),
    );
  }

  if (
    decoded.ttlExtensions.operationCount > 0 &&
    decoded.ttlExtensions.maxExtendToLedger > thresholds.ttlExtensionLedgerThreshold
  ) {
    indicators.push(
      indicator(
        'CONTRACT_TTL_EXTENSION_EXCESSIVE',
        'contract',
        'medium',
        'Extends ledger entries far beyond the rent window',
        `extendFootprintTtl targets ledger ${decoded.ttlExtensions.maxExtendToLedger}, past the ${thresholds.ttlExtensionLedgerThreshold}-ledger (roughly 30 day) threshold. Very long TTLs are the standard way state is pinned in place so it survives until the incident is forgotten.`,
        'Extend only as far as the operation actually needs, and state any long-lived requirement explicitly.',
        {
          maxExtendToLedger: decoded.ttlExtensions.maxExtendToLedger,
          threshold: thresholds.ttlExtensionLedgerThreshold,
          operationCount: decoded.ttlExtensions.operationCount,
        },
      ),
    );
  }

  if (decoded.ttlExtensions.restoreFootprintOperationCount > 0) {
    indicators.push(
      indicator(
        'CONTRACT_RESTORE_FOOTPRINT_OP',
        'contract',
        'high',
        'Revives archived ledger entries mid-envelope',
        `The envelope carries ${decoded.ttlExtensions.restoreFootprintOperationCount} restoreFootprint operation(s). Unlike a restore preamble, an in-envelope restore has no separate review step and no separate signature — it runs in the same atomic envelope as the value movement, which is exactly the shape a drain wants.`,
        'Restore archived entries in a separate, reviewed transaction ahead of this one rather than inside the value-moving envelope.',
        { operationCount: decoded.ttlExtensions.restoreFootprintOperationCount },
      ),
    );
  }

  return indicators;
}

/** Resource-consumption indicators derived from the simulation result. */
export function detectResourceIndicators(
  diff: FootprintDiff | null,
  simulation: SimulationResultInput | undefined,
  thresholds: SimulationThresholds,
): SimulationIndicator[] {
  const indicators: SimulationIndicator[] = [];

  const cpuInstructions = simulation?.costCpuInsns
    ? toUnsignedBigInt(simulation.costCpuInsns)
    : null;
  if (cpuInstructions !== null && cpuInstructions > thresholds.cpuInstructionThreshold) {
    indicators.push(
      indicator(
        'RESOURCE_CPU_BUDGET_ANOMALY',
        'resource',
        'medium',
        'Simulated CPU cost far exceeds a normal invocation',
        `The simulation billed ${cpuInstructions} CPU instructions, above the ${thresholds.cpuInstructionThreshold} threshold. Unbounded loops are the classic denial-of-service shape in a contract call.`,
        'Confirm the contract entry point terminates on adversarial input, especially over unbounded collections.',
        {
          costCpuInsns: cpuInstructions.toString(),
          threshold: thresholds.cpuInstructionThreshold.toString(),
        },
      ),
    );
  }

  if (diff !== null && diff.accessedCount > thresholds.maxFootprintEntries) {
    indicators.push(
      indicator(
        'RESOURCE_FOOTPRINT_SIZE',
        'resource',
        'low',
        'Touches an unusually large number of ledger entries',
        `${diff.accessedCount} ledger entries were accessed, above the ${thresholds.maxFootprintEntries}-entry review threshold. Large footprints are how one transaction moves many positions at once.`,
        'Confirm the operation is meant to touch this many entries in a single transaction.',
        {
          accessedCount: diff.accessedCount,
          threshold: thresholds.maxFootprintEntries,
        },
      ),
    );
  }

  return indicators;
}

/* ──────────────────────── risk scoring / verdict ────────────────── */

export function riskLevelForScore(score: number): SimulationRiskLevel {
  if (score >= RISK_LEVEL_FLOORS.critical) return 'critical';
  if (score >= RISK_LEVEL_FLOORS.high) return 'high';
  if (score >= RISK_LEVEL_FLOORS.medium) return 'medium';
  if (score >= RISK_LEVEL_FLOORS.low) return 'low';
  return 'none';
}

/**
 * Maps an assessment to a sign/hold/reject decision.
 *
 * A `block` verdict comes from *either* a saturated score *or* the presence of
 * a single `critical` indicator. The second rule is the important one: a
 * critical indicator is worth 40 points, so on score alone it would sit at the
 * `high` floor and produce `review`. A confirmed drain or an unverified
 * contract must not be a prompt to "have a look" — one critical finding is
 * enough to refuse the envelope regardless of what else it did or did not trip.
 */
export function verdictFor(
  level: SimulationRiskLevel,
  worstSeverity: SimulationSeverity | null,
): SimulationVerdict {
  if (level === 'critical' || worstSeverity === 'critical') return 'block';
  if (level === 'high' || level === 'medium') return 'review';
  return 'allow';
}

function worstSeverity(indicators: SimulationIndicator[]): SimulationSeverity | null {
  for (const severity of SEVERITY_ORDER) {
    if (indicators.some((i) => i.severity === severity)) {
      return severity;
    }
  }
  return null;
}

/**
 * Scores indicators into a single actionable 0–100 number plus a per-category
 * breakdown.
 *
 * Scoring is a clamped sum of severity weights (the same weighting
 * `utils/wasm-analyzer.ts` uses) rather than a product or a curve, on
 * purpose: clamp-and-sum makes each indicator's contribution legible, so a
 * client can see that a `critical` is worth 40 points and re-weight it for
 * its own use case. The breakdown is derived from the same indicator list, so
 * the total always equals the sum of the category scores modulo the clamp.
 */
export function assessRisk(indicators: SimulationIndicator[]): SimulationRiskAssessment {
  const score = Math.min(
    100,
    indicators.reduce((sum, i) => sum + SEVERITY_WEIGHTS[i.severity], 0),
  );

  const breakdown = CATEGORY_ORDER.map((category) => {
    const categoryIndicators = indicators.filter((i) => i.category === category);
    return {
      category,
      score: Math.min(
        100,
        categoryIndicators.reduce((sum, i) => sum + SEVERITY_WEIGHTS[i.severity], 0),
      ),
      indicatorCodes: categoryIndicators.map((i) => i.code),
      indicatorCount: categoryIndicators.length,
      worstSeverity: worstSeverity(categoryIndicators),
    };
  }).filter((entry) => entry.indicatorCount > 0);

  const actionable = indicators
    .filter((i) => i.severity === 'critical' || i.severity === 'high')
    .sort((a, b) => SEVERITY_WEIGHTS[b.severity] - SEVERITY_WEIGHTS[a.severity]);

  const recommendations: string[] = [];
  for (const i of actionable) {
    if (!recommendations.includes(i.remediation)) {
      recommendations.push(i.remediation);
    }
  }

  const level = riskLevelForScore(score);

  return {
    score,
    level,
    verdict: verdictFor(level, worstSeverity(indicators)),
    indicators,
    breakdown,
    recommendations: recommendations.slice(0, MAX_EVIDENCE_ITEMS),
  };
}

/* ───────────────────────────── orchestrator ─────────────────────── */

function resolveThresholds(options: SimulationOptions | undefined): SimulationThresholds {
  const merged: SimulationThresholds = { ...DEFAULT_SIMULATION_THRESHOLDS, ...(options ?? {}) };
  return {
    drainExhaustionRatio: clampPositive(merged.drainExhaustionRatio),
    drainSplitDestinationThreshold: Math.max(1, Math.trunc(merged.drainSplitDestinationThreshold)),
    ttlExtensionLedgerThreshold: Math.max(1, Math.trunc(merged.ttlExtensionLedgerThreshold)),
    cpuInstructionThreshold:
      merged.cpuInstructionThreshold > 0n ? merged.cpuInstructionThreshold : 0n,
    maxFootprintEntries: Math.max(1, Math.trunc(merged.maxFootprintEntries)),
    pathPaymentAsymmetryRatio: Math.max(1, merged.pathPaymentAsymmetryRatio),
    footprintExpansionRatio: Math.max(1, merged.footprintExpansionRatio),
    dustResidueStroops:
      merged.dustResidueStroops > 0n ? merged.dustResidueStroops : 0n,
  };
}

/**
 * Runs the full pre-execution analysis over one envelope and returns the
 * report: the decoded envelope, the footprint diff (when a simulation was
 * supplied), and the scored risk assessment with its indicator breakdown.
 *
 * Throws when the envelope cannot be decoded — an undecodable envelope is a
 * client error, not a clean report, and silently scoring it 0 would be the
 * most dangerous possible answer.
 */
export function simulateTransactionEnvelope(input: SimulationInput): SimulationReport {
  const thresholds = resolveThresholds(input.options);
  const decoded = decodeEnvelope(input.envelopeXdr, input.networkPassphrase);

  const simulation = input.simulation ?? undefined;
  const footprintDiff = simulation
    ? computeFootprintDiff(decoded.declaredFootprint, {
        readOnly: simulation.readOnlyLedgerKeys ?? [],
        readWrite: simulation.readWriteLedgerKeys ?? [],
        archived: simulation.archivedLedgerKeys,
      })
    : null;

  const indicators: SimulationIndicator[] = [
    ...(footprintDiff ? detectFootprintIndicators(footprintDiff, simulation, thresholds) : []),
    ...detectDrainIndicators(decoded, input.ledgerBaseline, thresholds),
    ...detectAuthorizationIndicators(decoded),
    ...detectContractIndicators(decoded, input.ledgerBaseline, thresholds),
    ...detectResourceIndicators(footprintDiff, simulation, thresholds),
  ];

  const baseline = input.ledgerBaseline ?? null;

  return {
    envelope: decoded,
    footprintDiff,
    risk: assessRisk(indicators),
    coverage: {
      footprintDiff: footprintDiff !== null,
      balanceBaseline: Boolean(baseline?.nativeBalanceStroops),
      trustedContractBaseline: (baseline?.trustedContracts ?? []).length > 0,
      recipientBaseline: (baseline?.knownRecipients ?? []).length > 0,
    },
  };
}
