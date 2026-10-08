/**
 * Pre-execution simulation engine for Stellar & Soroban transaction envelopes.
 *
 * Given a description of an envelope plus whatever pre-execution evidence the
 * caller has (ledger state snapshots, a host simulation result, contract state,
 * and an operator trust registry), this produces a single
 * {@link SimulationReport}: a footprint diff, a drain breakdown, a contract
 * interaction analysis, the full list of triggered risk indicators, and an
 * explainable threat risk score.
 *
 * ## What this is and is not
 *
 * This is a *decision-support* engine, deliberately not a sandbox. It reasons
 * over supplied state and a footprint diff; it does not execute the envelope,
 * contact a Soroban RPC node, or prove anything about a contract's behaviour. Its
 * output is only as good as its inputs, which is why the report carries an
 * explicit `meta.simulated` flag and why `NO_SIMULATION_RESULT` is itself an
 * indicator — an analysis run without a host simulation is explicitly scored as
 * a lower bound on the real risk rather than silently presented as complete.
 *
 * ## Pure by construction
 *
 * No `prisma`, no `config/env`, no network. Everything arrives through
 * {@link SimulationRequest} and every threshold through
 * {@link SimulationEngineOptions}, which is what makes the whole engine
 * exhaustively testable and safe to reuse from workers.
 */

import { formatStroops } from './amounts';
import { analyzeContractInteractions } from './contract-trust';
import { analyzeDrain, type DrainThresholds } from './drain-detector';
import { analyzeEnvelopeIntegrity, analyzeFootprintThreats, type FootprintThreatThresholds } from './envelope-integrity';
import { diffFootprints } from './footprint-diff';
import { DEFAULT_RISK_BLOCK_THRESHOLD, scoreRisk } from './risk-scorer';
import type {
  ContractInteractionAnalysis,
  DrainAnalysis,
  FootprintDiff,
  RiskIndicator,
  SimulationEngineOptions,
  SimulationMeta,
  SimulationReport,
  SimulationRequest,
} from './types';

/** Engine defaults. Every one of these is overridable per call. */
export const DEFAULT_SIMULATION_OPTIONS: Required<
  Omit<SimulationEngineOptions, 'dustAmountStroops'>
> & { dustAmountStroops: bigint } = {
  nearTotalOutflowRatio: 0.85,
  fanOutDestinationThreshold: 3,
  sequentialTransferThreshold: 8,
  dustAmountStroops: 10n,
  maxFootprintReadWriteKeys: 64,
  footprintProbeContractThreshold: 5,
  maxInvocationsPerContract: 5,
  riskBlockThreshold: DEFAULT_RISK_BLOCK_THRESHOLD,
};

/**
 * Pre-execution simulation engine.
 *
 * Stateless and immutable apart from the resolved threshold set, so a single
 * instance can be shared process-wide (as {@link simulationEngine} is) and
 * concurrent calls cannot interfere with each other.
 */
export class SimulationEngine {
  private readonly defaults: SimulationEngineOptions;

  constructor(defaults: SimulationEngineOptions = {}) {
    this.defaults = { ...defaults };
  }

  /** Resolves per-call options over the instance defaults and the module defaults. */
  private resolveOptions(options: SimulationEngineOptions): typeof DEFAULT_SIMULATION_OPTIONS {
    const merged = { ...DEFAULT_SIMULATION_OPTIONS, ...this.defaults, ...options };
    return {
      ...merged,
      // The ratio is a probability-like value; clamp it into (0, 1] so a bad
      // config can never make every asset count as "fully drained" (ratio > 1)
      // or none of them (ratio ≤ 0).
      nearTotalOutflowRatio: Math.min(1, Math.max(0.01, merged.nearTotalOutflowRatio)),
      dustAmountStroops:
        merged.dustAmountStroops !== undefined && merged.dustAmountStroops >= 0n
          ? merged.dustAmountStroops
          : DEFAULT_SIMULATION_OPTIONS.dustAmountStroops,
    };
  }

  /**
   * Analyzes one envelope and returns the complete report.
   *
   * Never throws for malformed or partial input: an envelope with no operations,
   * no pre-state, and no simulation result still produces a well-formed report
   * (with the corresponding "we don't know" indicators) rather than an error.
   * That matters because this sits on a signing path, where a thrown exception
   * must not be mistaken for "no risk found".
   */
  public simulate(request: SimulationRequest, options: SimulationEngineOptions = {}): SimulationReport {
    const resolved = this.resolveOptions(options);
    const operations = request.operations ?? [];
    const resources = request.resources;
    const outcome = request.outcome;

    const invocations = operations.filter((op) => op.kind === 'invokeContract');
    const transfers = operations.filter(
      (op) =>
        op.kind === 'pay' ||
        op.kind === 'pathPaymentStrictReceive' ||
        op.kind === 'pathPaymentStrictSend' ||
        op.kind === 'accountMerge',
    );
    const hasInvocation = invocations.length > 0;
    const simulated = outcome !== undefined;

    // ── Drain ────────────────────────────────────────────────────────────────
    const drainThresholds: DrainThresholds = {
      nearTotalOutflowRatio: resolved.nearTotalOutflowRatio,
      fanOutDestinationThreshold: resolved.fanOutDestinationThreshold,
      sequentialTransferThreshold: resolved.sequentialTransferThreshold,
      dustAmountStroops: resolved.dustAmountStroops,
    };
    const drainResult = analyzeDrain(
      request.sourceAccount,
      operations,
      request.preState,
      request.postState ?? outcome?.resultingBalances,
      drainThresholds,
    );

    // ── Footprint ───────────────────────────────────────────────────────────
    const declaredFootprint = resources?.footprint;
    const requiredFootprint = resources?.requiredFootprint;
    // Only diff when at least one side exists: a classic (non-Soroban) envelope
    // has no footprint on either side, and reporting `footprint: null` is more
    // honest than reporting an empty diff.
    const footprint: FootprintDiff | null =
      declaredFootprint !== undefined || requiredFootprint !== undefined
        ? diffFootprints(declaredFootprint, requiredFootprint)
        : null;

    const footprintThresholds: FootprintThreatThresholds = {
      maxFootprintReadWriteKeys: resolved.maxFootprintReadWriteKeys,
      footprintProbeContractThreshold: resolved.footprintProbeContractThreshold,
    };

    const footprintIndicators: RiskIndicator[] = footprint
      ? analyzeFootprintThreats(footprint, declaredFootprint, hasInvocation, footprintThresholds)
      : [];

    // ── Contracts ───────────────────────────────────────────────────────────
    const contractResult = analyzeContractInteractions(
      request.sourceAccount,
      operations,
      request.contracts,
      request.trustRegistry,
      resources?.auth,
      { maxInvocationsPerContract: resolved.maxInvocationsPerContract },
    );

    // ── Envelope ────────────────────────────────────────────────────────────
    const envelopeIndicators = analyzeEnvelopeIntegrity({
      sourceAccount: request.sourceAccount,
      operations,
      resources,
      outcome,
      hasInvocation,
      simulated,
    });

    // ── Score ───────────────────────────────────────────────────────────────
    const indicators = [
      ...drainResult.indicators,
      ...footprintIndicators,
      ...contractResult.indicators,
      ...envelopeIndicators,
    ];

    const risk = scoreRisk(indicators, { blockThreshold: resolved.riskBlockThreshold });

    const preSnapshot = (request.preState ?? []).find((s) => s.accountId === request.sourceAccount);
    const postSnapshot = (request.postState ?? outcome?.resultingBalances ?? []).find(
      (s) => s.accountId === request.sourceAccount,
    );

    const meta: SimulationMeta = {
      operationCount: resources?.operationCount ?? operations.length,
      invocationCount: invocations.length,
      transferCount: transfers.length,
      simulated,
      simulationSucceeded: outcome?.success ?? false,
      hasBalanceDiff: preSnapshot !== undefined && postSnapshot !== undefined,
      thresholds: {
        nearTotalOutflowRatio: resolved.nearTotalOutflowRatio,
        fanOutDestinationThreshold: resolved.fanOutDestinationThreshold,
        sequentialTransferThreshold: resolved.sequentialTransferThreshold,
        maxFootprintReadWriteKeys: resolved.maxFootprintReadWriteKeys,
        footprintProbeContractThreshold: resolved.footprintProbeContractThreshold,
        maxInvocationsPerContract: resolved.maxInvocationsPerContract,
        riskBlockThreshold: resolved.riskBlockThreshold,
        dustAmountStroops: resolved.dustAmountStroops.toString(),
      },
    };

    return {
      sourceAccount: request.sourceAccount,
      ...(request.network !== undefined ? { network: request.network } : {}),
      ...(request.label !== undefined ? { label: request.label } : {}),
      analyzedAt: new Date().toISOString(),
      drain: drainResult.analysis,
      footprint,
      contracts: contractResult.analysis,
      indicators: dedupePreservingOrder(indicators),
      risk,
      meta,
    };
  }

  /**
   * Convenience wrapper returning just the score/band, for callers that only need
   * a gate decision and don't want to retain the full report.
   */
  public scoreOnly(request: SimulationRequest, options: SimulationEngineOptions = {}) {
    return this.simulate(request, options).risk;
  }
}

/** Stable order-preserving dedupe, so report indicator order is reproducible. */
function dedupePreservingOrder(indicators: RiskIndicator[]): RiskIndicator[] {
  const seen = new Set<string>();
  const result: RiskIndicator[] = [];
  for (const indicator of indicators) {
    if (seen.has(indicator.code)) continue;
    seen.add(indicator.code);
    result.push(indicator);
  }
  return result;
}

/** Process-wide engine instance using the module defaults. */
export const simulationEngine = new SimulationEngine();
