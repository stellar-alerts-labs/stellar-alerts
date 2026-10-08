/**
 * Shared types for the pre-execution simulation engine.
 *
 * The engine is deliberately input-model-first: everything it analyses is
 * described by these plain data structures, which are simple enough to produce
 * from *any* of the three sources a caller might have — a real
 * `TransactionEnvelope` decoded from XDR, a hand-built envelope description
 * from a wallet, or a fixture in a test. Nothing in this directory imports
 * `prisma`, `config/env`, or performs network I/O, which is what lets
 * `simulation-engine.ts` be exercised as a pure function in unit tests and
 * reused from workers without a database.
 */

// ── Assets ───────────────────────────────────────────────────────────────────

export type AssetType = 'native' | 'credit_alphanumeric' | 'liquidity_pool';

export interface AssetRef {
  type: AssetType;
  /** Asset code for `credit_alphanumeric`. Case-insensitive on the wire. */
  code?: string;
  /** Issuer account id for `credit_alphanumeric`. */
  issuer?: string;
  /** Pool id for `liquidity_pool`. */
  poolId?: string;
}

// ── Footprint ────────────────────────────────────────────────────────────────

/** Access mode a ledger key is declared/required under in a Soroban footprint. */
export type FootprintAccess = 'readOnly' | 'readWrite' | 'archived';

export interface FootprintKey {
  /**
   * Stable canonical identity of the ledger key, e.g.
   * `contractData:CABC…:0000…0001` or `account:GABC…`.
   */
  key: string;
  /** Ledger entry type (`contractData`, `contractCode`, `contractInstance`, `account`, …). */
  entryType: string;
  /** Contract the key belongs to, when applicable. */
  contractId?: string;
  access: FootprintAccess;
}

export interface TransactionFootprint {
  readOnly: FootprintKey[];
  readWrite: FootprintKey[];
  archived: FootprintKey[];
}

export type FootprintChange = 'missing' | 'unused' | 'unchanged' | 'mode_changed';

export interface FootprintDiffEntry {
  key: string;
  entryType: string;
  contractId?: string;
  change: FootprintChange;
  declaredAccess?: FootprintAccess;
  requiredAccess?: FootprintAccess;
}

export interface FootprintDiff {
  entries: FootprintDiffEntry[];
  summary: {
    declaredReadOnly: number;
    declaredReadWrite: number;
    declaredArchived: number;
    requiredReadOnly: number;
    requiredReadWrite: number;
    requiredArchived: number;
    /** Required keys the envelope never declared. */
    missingCount: number;
    /** Declared keys the host says the envelope never touches. */
    unusedCount: number;
    modeChangedCount: number;
    /** Distinct contract ids spanned by the declared footprint. */
    contractIdCount: number;
  };
}

// ── Balances / pre-execution state ───────────────────────────────────────────

export interface AssetBalance {
  asset: AssetRef;
  /** Spendable balance as a decimal string (≤ 7 dp). */
  balance: string;
  /** Trustline limit as a decimal string, for credit balances. */
  limit?: string;
  /**
   * True when the holder's trustline can be revoked by the issuer (clawback
   * still available). Undefined means "unknown", treated as *not* revocable so
   * the engine never invents a finding from missing data.
   */
  revocable?: boolean;
}

export interface AccountStateSnapshot {
  accountId: string;
  /** Native (XLM) balance as a decimal string. */
  nativeBalance?: string;
  /** Non-native balances (trustlines, pool shares) keyed by canonical asset key. */
  balances?: AssetBalance[];
}

// ── Operations ───────────────────────────────────────────────────────────────

export type OperationKind =
  | 'pay'
  | 'pathPaymentStrictReceive'
  | 'pathPaymentStrictSend'
  | 'accountMerge'
  | 'clawback'
  | 'changeTrust'
  | 'setTrustlineFlags'
  | 'createAccount'
  | 'createContract'
  | 'uploadWasm'
  | 'invokeContract'
  | 'extendFootprintTtl'
  | 'restoreFootprint'
  | 'bumpSequence'
  | 'setOptions'
  | 'manageSellOffer'
  | 'liquidityPoolWithdraw'
  | 'unknown';

export interface SimulatedOperation {
  kind: OperationKind;
  /** Account the operation debits / is submitted from. Defaults to the envelope source. */
  source?: string;
  /** Transfer destination, for outgoing-value operations. */
  destination?: string;
  asset?: AssetRef;
  /** Amount as a decimal string. */
  amount?: string;
  /** Contract targeted by `invokeContract` / `createContract`. */
  contractId?: string;
  /** Contract function invoked (Soroban). */
  function?: string;
  /** Function arguments, retained for evidence/debugging only. */
  args?: unknown[];
  /** Trustline asset for `changeTrust` / `setTrustlineFlags` / `clawback`. */
  trustlineAsset?: AssetRef;
  /** `setTrustlineFlags` mask flags — used to detect revocation windows. */
  trustlineFlagMask?: number;
}

// ── Envelope-level resources ─────────────────────────────────────────────────

export interface SimulatedAuthEntry {
  /** Address whose signature authorizes the action. */
  credentialsAddress?: string;
  contractId?: string;
  function?: string;
}

export interface EnvelopeResources {
  /** Footprint declared by the envelope. Absent for non-Soroban envelopes. */
  footprint?: TransactionFootprint;
  /** Footprint the host reports the envelope actually requires. */
  requiredFootprint?: TransactionFootprint;
  /** Resource cap for the envelope; absent/null means unbounded. */
  ledgerBounds?: { min: number; max: number } | null;
  /** Soroban `SorobanAuthorizationEntry` list. */
  auth?: SimulatedAuthEntry[];
  /** Whether the envelope declares `preconditions.timeBounds`. */
  hasTimeBounds?: boolean;
  /** Declared fee in stroops (decimal string). */
  feeStroops?: string;
  /** Operation count, when known without decoding every operation. */
  operationCount?: number;
}

// ── Simulation outcome ───────────────────────────────────────────────────────

export interface SimulatedError {
  type: 'custom_error' | 'panic' | 'host_error' | 'invocation_error';
  code?: number;
  message: string;
  contractId?: string;
  function?: string;
}

export interface SimulatedEvent {
  contractId?: string;
  type?: string;
  /** Decoded value payload, when available. */
  value?: unknown;
}

export interface SimulatedOutcome {
  /** Ledger the simulation ran against. */
  ledger?: number;
  /** False when the host reverted/trapped the transaction. */
  success?: boolean;
  /** Diagnostic errors raised during simulation. */
  errors?: SimulatedError[];
  /** Post-execution balances per account. */
  resultingBalances?: AccountStateSnapshot[];
  /** Contract events the envelope would emit. */
  events?: SimulatedEvent[];
  /** Fee the envelope would cost, in stroops (decimal string). */
  feeStroops?: string;
}

// ── Contract trust ───────────────────────────────────────────────────────────

/** A contract's on-ledger state, as observed during pre-execution. */
export interface ContractStateSnapshot {
  contractId: string;
  /** WASM hash recorded in the contract instance entry (hex). */
  wasmHash?: string;
  /** Whether the contract instance still exists on-ledger. */
  deployed?: boolean;
  /** Whether its WASM code entry is archived (restoration required first). */
  codeArchived?: boolean;
}

export interface ContractTrustRecord {
  contractId: string;
  /** True when the contract has passed source/WASM verification. */
  verified?: boolean;
  /** SHA-256 of the audited WASM build (hex). */
  wasmHash?: string;
  /** Account that deployed the contract. */
  deployer?: string;
  /** Verification timestamp (ISO date or date-time). */
  verifiedAt?: string;
}

/**
 * Operator-supplied trust context. `Map`/`Set`/array/record forms are all
 * accepted and normalized by the engine, so a caller can pass whichever shape
 * they already hold.
 */
export interface ContractTrustRegistry {
  byContractId?: Map<string, ContractTrustRecord> | Record<string, ContractTrustRecord>;
  /** Contract ids an operator has explicitly blessed. */
  allowlist?: Set<string> | string[];
  /** Deployer account ids trusted to deploy contracts that are already verified. */
  trustedDeployers?: Set<string> | string[];
}

// ── Drain analysis ───────────────────────────────────────────────────────────

export interface AssetFlow {
  asset: AssetRef;
  canonicalKey: string;
  preBalanceStroops: string;
  postBalanceStroops: string;
  /** Value that left the source account, in stroops. */
  outflowStroops: string;
  /** Value that arrived in the source account, in stroops. */
  inflowStroops: string;
  /** `outflow / preBalance` as a 2-dp percentage string ("97.50"). */
  outflowPercent: string;
  /** True when the outflow consumed (nearly) the entire pre-balance. */
  drained: boolean;
}

export interface DrainAnalysis {
  /** Per-asset pre→post balance movement for the source account. */
  flows: AssetFlow[];
  totalOutflowStroops: string;
  totalInflowStroops: string;
  /** Canonical asset keys whose balance was (nearly) fully drained. */
  drainedAssets: string[];
  /** Every destination account touched by an outgoing value transfer. */
  destinations: string[];
  /** Number of outgoing transfer operations attributed to the source account. */
  outgoingTransferCount: number;
  /** Canonical asset key → residual balance after the envelope. */
  residualBalances: Record<string, string>;
}

// ── Contract interaction analysis ────────────────────────────────────────────

export interface ContractInteraction {
  contractId: string;
  functions: string[];
  /** Operations that invoke this contract. */
  invocationCount: number;
  /** Whether any invocation was itself a deploy in the same envelope. */
  deployedInEnvelope: boolean;
  /** Whether an invocation needs `SorobanAuthorizationEntry` but has none. */
  missingAuth: boolean;
  /** Whether the contract holds a verified record in the trust registry. */
  verified: boolean;
  /** Whether the on-ledger WASM hash matches the registry's audited hash. */
  codeHashMismatch: boolean;
  /** Whether the registry has any record for this contract. */
  known: boolean;
}

export interface ContractInteractionAnalysis {
  interactions: ContractInteraction[];
  privilegedInvocations: SimulatedOperation[];
  unknownDeployers: string[];
  codeHashMismatches: string[];
  unverifiableContracts: string[];
}

// ── Risk ─────────────────────────────────────────────────────────────────────

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type IndicatorCategory = 'footprint' | 'drain' | 'contract' | 'envelope';

export interface RiskIndicator {
  /** Stable, machine-readable indicator id. Deduped — counted at most once. */
  code: string;
  category: IndicatorCategory;
  severity: RiskSeverity;
  /** Contribution to the 0-100 score. */
  weight: number;
  title: string;
  detail: string;
  /** The concrete next step a reviewer should take. */
  remediation: string;
  /** Structured facts backing this indicator. */
  evidence: Record<string, unknown>;
}

export type RiskBand = 'SAFE' | 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export interface RiskCategoryBreakdown {
  category: IndicatorCategory;
  /** Sum of this category's indicator weights. */
  score: number;
  /** This category's share of the total score, 2-dp string percentage. */
  sharePercent: string;
  indicatorCount: number;
  worstSeverity: RiskSeverity;
  codes: string[];
}

export interface ThreatRiskAssessment {
  /** 0 (benign) .. 100 (actively draining / critical). */
  score: number;
  band: RiskBand;
  /** Score at/above which execution is recommended to be blocked. */
  blockThreshold: number;
  /** True when `score >= blockThreshold`. */
  blockExecution: boolean;
  /** Category contributions, ordered by score descending. */
  breakdown: RiskCategoryBreakdown[];
  severityCounts: Record<RiskSeverity, number>;
  summary: string;
  /** Ordered, de-duplicated remediation steps for the reviewer. */
  actions: string[];
}

// ── Engine input / output ────────────────────────────────────────────────────

export interface SimulationRequest {
  /** Account submitting the envelope. */
  sourceAccount: string;
  /** Informational network label, e.g. `PUBLIC` or `TESTNET`. */
  network?: string;
  /** Caller-supplied label stored alongside the result. */
  label?: string;
  /** Base64 XDR of the envelope, when available. Retained for correlation only. */
  envelopeXdr?: string;
  operations: SimulatedOperation[];
  resources?: EnvelopeResources;
  /** Ledger state before the envelope would execute. */
  preState: AccountStateSnapshot[];
  /** Post-state, when the caller already simulated the envelope. */
  postState?: AccountStateSnapshot[];
  /** Result of an existing host simulation, when the caller already ran one. */
  outcome?: SimulatedOutcome;
  /** On-ledger state of every contract the envelope touches. */
  contracts?: ContractStateSnapshot[];
  /** Operator trust registry used to decide "verified". */
  trustRegistry?: ContractTrustRegistry;
}

export interface SimulationEngineOptions {
  /** Outflow/pre-balance ratio at/above which an asset counts as drained. Default 0.85. */
  nearTotalOutflowRatio?: number;
  /** Distinct destinations that count as fan-out. Default 3. */
  fanOutDestinationThreshold?: number;
  /** Outgoing transfers from one source that count as a burst. Default 8. */
  sequentialTransferThreshold?: number;
  /** Amounts below this are flagged as dust. Default 10 stroops (0.000001). */
  dustAmountStroops?: bigint;
  /** Declared read-write keys above this are flagged as unbounded growth. Default 64. */
  maxFootprintReadWriteKeys?: number;
  /** Distinct contract ids in a read-only footprint that count as probing. Default 5. */
  footprintProbeContractThreshold?: number;
  /** Invocations of one contract in a single envelope that count as fan-out. Default 5. */
  maxInvocationsPerContract?: number;
  /** Score at/above which `blockExecution` is true. Default 80. */
  riskBlockThreshold?: number;
}

export interface SimulationMeta {
  operationCount: number;
  invocationCount: number;
  transferCount: number;
  /** True when a host simulation result was supplied or derivable. */
  simulated: boolean;
  simulationSucceeded: boolean;
  /** True when any pre/post balance data was available to compare. */
  hasBalanceDiff: boolean;
  /** Engine option snapshot, so a stored report explains the thresholds used. */
  thresholds: Required<Omit<SimulationEngineOptions, 'dustAmountStroops'>> & {
    dustAmountStroops: string;
  };
}

export interface SimulationReport {
  sourceAccount: string;
  network?: string;
  label?: string;
  /** ISO timestamp of when the analysis ran. */
  analyzedAt: string;
  drain: DrainAnalysis;
  /** Null when the envelope declares no Soroban footprint. */
  footprint: FootprintDiff | null;
  contracts: ContractInteractionAnalysis;
  indicators: RiskIndicator[];
  risk: ThreatRiskAssessment;
  meta: SimulationMeta;
}
