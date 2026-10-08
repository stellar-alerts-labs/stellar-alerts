import { createHash } from 'crypto';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { NotFoundError } from '../../lib/errors';
import {
  SimulationEngine,
  type SimulationEngineOptions,
  type SimulationReport,
  type SimulationRequest,
} from '../../services/simulation';
import type { AnalyzeSimulationInput, ListSimulationsQuery } from './simulation.schema';

/**
 * Service layer for the pre-execution simulation engine.
 *
 * Responsibilities, in order:
 *  1. Translate the HTTP request shape into the engine's input model.
 *  2. Resolve engine thresholds from `config/env` so operators can tune
 *     detections without a deploy (the engine itself stays pure and default-only).
 *  3. Persist the resulting assessment — the whole point of a *pre-execution*
 *     control is that there is a reviewable record of what was checked, what was
 *     found, and under which thresholds, before the envelope was ever signed.
 *  4. Escalate HIGH/CRITICAL results into `SecurityAuditLog`, the stream
 *     operators already monitor, without duplicating every SAFE result into it.
 *
 * Failure handling is deliberately asymmetric, because the two writes are not
 * equally load-bearing:
 *
 *  - **Persistence fails closed.** The stored row *is* the durable audit record
 *    for a pre-signing decision, and `201` + `Location` promise an id that
 *    resolves. Returning a verdict the caller believes is recorded when it is
 *    not would be the worse lie, so a write failure surfaces as a 500.
 *  - **Audit-log writes are non-fatal.** By this point the assessment is already
 *    persisted, and a hiccup in the audit table must not turn "this envelope
 *    looks like a takeover attempt" into a 500 a caller could read as
 *    "no risk found". Failures are logged and swallowed.
 */

/** Bands escalated into the SecurityAuditLog stream. */
const AUDITED_BANDS: ReadonlySet<string> = new Set(['HIGH', 'CRITICAL']);

export interface SimulationEngineThresholds {
  nearTotalOutflowRatio: number;
  fanOutDestinationThreshold: number;
  sequentialTransferThreshold: number;
  maxFootprintReadWriteKeys: number;
  footprintProbeContractThreshold: number;
  maxInvocationsPerContract: number;
  riskBlockThreshold: number;
  dustAmountStroops: bigint;
}

/** Documented defaults; must stay in sync with config/env.ts. */
const DEFAULT_ENGINE_THRESHOLDS = {
  nearTotalOutflowRatio: 0.85,
  fanOutDestinationThreshold: 3,
  sequentialTransferThreshold: 8,
  maxFootprintReadWriteKeys: 64,
  footprintProbeContractThreshold: 5,
  maxInvocationsPerContract: 5,
  riskBlockThreshold: 80,
  dustAmountStroops: 10n,
};

/** Picks a configured number, falling back when it is absent or not a number. */
function thresholdNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Resolves engine thresholds from environment configuration.
 *
 * Each key falls back independently to the documented default rather than
 * assuming a fully-populated `env`. `SimulationService` is constructed at module
 * scope (see `simulationService` below), so this runs during import of the route
 * module: a missing key must degrade to a safe default, never throw and take
 * the whole app down with it.
 *
 * `SIMULATION_NEAR_TOTAL_OUTFLOW_RATIO` is clamped here as well as inside the
 * engine so the value echoed back in the report's `meta.thresholds` is the value
 * actually applied.
 */
export function resolveEngineThresholds(source = env): SimulationEngineThresholds {
  const dust = thresholdNumber(
    source.SIMULATION_DUST_AMOUNT_STROOPS,
    Number(DEFAULT_ENGINE_THRESHOLDS.dustAmountStroops),
  );
  return {
    nearTotalOutflowRatio: Math.min(
      1,
      Math.max(0.01, thresholdNumber(source.SIMULATION_NEAR_TOTAL_OUTFLOW_RATIO, DEFAULT_ENGINE_THRESHOLDS.nearTotalOutflowRatio)),
    ),
    fanOutDestinationThreshold: thresholdNumber(source.SIMULATION_FAN_OUT_DESTINATION_THRESHOLD, DEFAULT_ENGINE_THRESHOLDS.fanOutDestinationThreshold),
    sequentialTransferThreshold: thresholdNumber(source.SIMULATION_SEQUENTIAL_TRANSFER_THRESHOLD, DEFAULT_ENGINE_THRESHOLDS.sequentialTransferThreshold),
    maxFootprintReadWriteKeys: thresholdNumber(source.SIMULATION_MAX_FOOTPRINT_READ_WRITE_KEYS, DEFAULT_ENGINE_THRESHOLDS.maxFootprintReadWriteKeys),
    footprintProbeContractThreshold: thresholdNumber(source.SIMULATION_FOOTPRINT_PROBE_CONTRACT_THRESHOLD, DEFAULT_ENGINE_THRESHOLDS.footprintProbeContractThreshold),
    maxInvocationsPerContract: thresholdNumber(source.SIMULATION_MAX_INVOCATIONS_PER_CONTRACT, DEFAULT_ENGINE_THRESHOLDS.maxInvocationsPerContract),
    riskBlockThreshold: thresholdNumber(source.SIMULATION_RISK_BLOCK_THRESHOLD, DEFAULT_ENGINE_THRESHOLDS.riskBlockThreshold),
    dustAmountStroops: BigInt(Math.trunc(dust)),
  };
}

/**
 * Normalizes a loosely-typed footprint from the HTTP DTO into the engine's
 * strict model.
 *
 * The request schema treats each footprint bucket as optional (a caller may only
 * know the read-write half), but the engine's `TransactionFootprint` requires all
 * three arrays. Filling them with `[]` here is what makes an *absent* bucket
 * distinguishable from a populated one: `[]` vs. `[]` both mean "no keys", and
 * the engine reports `FOOTPRINT_EMPTY_WITH_INVOCATION` only when the declared
 * footprint is genuinely empty, not merely incompletely described.
 */
function toEngineFootprint(
  footprint: { readOnly?: unknown[]; readWrite?: unknown[]; archived?: unknown[] } | undefined,
): { readOnly: any[]; readWrite: any[]; archived: any[] } | undefined {
  if (!footprint) return undefined;
  return {
    readOnly: (footprint.readOnly ?? []) as any[],
    readWrite: (footprint.readWrite ?? []) as any[],
    archived: (footprint.archived ?? []) as any[],
  };
}

/**
 * Maps the request DTO onto the engine's input model.
 *
 * Exported (and separately unit-tested) because this is the one place where a
 * malformed request could silently become a *less* alarming report — e.g. losing
 * a post-state snapshot would drop every balance-delta rule.
 */
export function toEngineRequest(input: AnalyzeSimulationInput): SimulationRequest {
  const resources = input.resources;
  return {
    sourceAccount: input.sourceAccount,
    ...(input.network !== undefined ? { network: input.network } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.envelopeXdr !== undefined ? { envelopeXdr: input.envelopeXdr } : {}),
    operations: input.operations,
    ...(resources !== undefined
      ? {
          resources: {
            ...(resources.footprint ? { footprint: toEngineFootprint(resources.footprint) } : {}),
            ...(resources.requiredFootprint
              ? { requiredFootprint: toEngineFootprint(resources.requiredFootprint) }
              : {}),
            ...(resources.ledgerBounds !== undefined ? { ledgerBounds: resources.ledgerBounds } : {}),
            ...(resources.auth !== undefined ? { auth: resources.auth } : {}),
            ...(resources.hasTimeBounds !== undefined ? { hasTimeBounds: resources.hasTimeBounds } : {}),
            ...(resources.feeStroops !== undefined ? { feeStroops: resources.feeStroops } : {}),
            ...(resources.operationCount !== undefined
              ? { operationCount: resources.operationCount }
              : {}),
          },
        }
      : {}),
    preState: input.preState ?? [],
    ...(input.postState !== undefined ? { postState: input.postState } : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    ...(input.contracts !== undefined ? { contracts: input.contracts } : {}),
    ...(input.trustRegistry !== undefined ? { trustRegistry: input.trustRegistry } : {}),
  };
}

export interface StoredSimulation {
  id: string;
  sourceAccount: string;
  network: string;
  label: string | null;
  envelopeHash: string | null;
  score: number;
  band: string;
  blockExecution: boolean;
  indicatorCodes: string[];
  report: unknown;
  createdAt: Date;
}

export class SimulationService {
  constructor(
    private readonly engine: SimulationEngine = new SimulationEngine(),
    private readonly thresholds: SimulationEngineThresholds = resolveEngineThresholds(),
  ) {}

  /**
   * Runs the engine and persists the assessment.
   *
   * @returns the stored row, so the caller gets a durable id to correlate the
   *   pre-signing review with.
   */
  async analyze(userId: string, input: AnalyzeSimulationInput): Promise<StoredSimulation> {
    const report = this.engine.simulate(
      toEngineRequest(input),
      this.thresholds as SimulationEngineOptions,
    );

    const envelopeHash = input.envelopeXdr
      ? createHash('sha256').update(input.envelopeXdr).digest('hex')
      : null;

    const indicatorCodes = report.indicators.map((i) => i.code);

    const row = await this.persist({
      userId,
      sourceAccount: report.sourceAccount,
      network: report.network ?? 'PUBLIC',
      label: report.label ?? null,
      envelopeHash,
      score: report.risk.score,
      band: report.risk.band,
      blockExecution: report.risk.blockExecution,
      indicatorCodes,
      report: report as unknown as Record<string, unknown>,
    });

    if (AUDITED_BANDS.has(report.risk.band)) {
      await this.writeAuditLog(userId, report, envelopeHash, indicatorCodes);
    }

    return row;
  }

  /** Paginated, owner-scoped history. Optional band/source filters. */
  async list(
    userId: string,
    query: ListSimulationsQuery,
  ): Promise<{ simulations: StoredSimulation[]; total: number; page: number; pageSize: number }> {
    const where = {
      userId,
      ...(query.band !== undefined ? { band: query.band } : {}),
      ...(query.sourceAccount !== undefined ? { sourceAccount: query.sourceAccount } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.transactionSimulation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.transactionSimulation.count({ where }),
    ]);

    return {
      simulations: rows.map((r) => this.toStored(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Fetches one simulation by id, scoped to its owner.
   *
   * Scoping in the `where` clause (rather than fetching then comparing) means a
   * caller cannot distinguish "does not exist" from "belongs to someone else" —
   * both return the same 404, so the endpoint can't be used to probe ids.
   */
  async get(userId: string, id: string): Promise<StoredSimulation> {
    const row = await prisma.transactionSimulation.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundError('Simulation not found', 'SIMULATION_NOT_FOUND');
    return this.toStored(row);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async persist(data: {
    userId: string;
    sourceAccount: string;
    network: string;
    label: string | null;
    envelopeHash: string | null;
    score: number;
    band: string;
    blockExecution: boolean;
    indicatorCodes: string[];
    report: Record<string, unknown>;
  }): Promise<StoredSimulation> {
    const row = await prisma.transactionSimulation.create({
      data: {
        userId: data.userId,
        sourceAccount: data.sourceAccount,
        network: data.network,
        label: data.label,
        envelopeHash: data.envelopeHash,
        score: data.score,
        band: data.band,
        blockExecution: data.blockExecution,
        indicatorCodes: data.indicatorCodes,
        report: data.report as any,
      },
    });
    return this.toStored(row);
  }

  /**
   * Escalation into the shared security audit stream. Failure is logged and
   * swallowed: the assessment is already persisted, and losing the audit copy
   * must not fail the request that produced a perfectly valid threat score.
   */
  private async writeAuditLog(
    userId: string,
    report: SimulationReport,
    envelopeHash: string | null,
    indicatorCodes: string[],
  ): Promise<void> {
    try {
      await prisma.securityAuditLog.create({
        data: {
          eventType: 'TRANSACTION_SIMULATION_RISK',
          severity: report.risk.band === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
          details: {
            userId,
            sourceAccount: report.sourceAccount,
            network: report.network ?? null,
            label: report.label ?? null,
            envelopeHash,
            score: report.risk.score,
            band: report.risk.band,
            blockExecution: report.risk.blockExecution,
            indicatorCodes,
            worstSeverity:
              report.risk.breakdown[0]?.worstSeverity ?? 'info',
            categoryScores: Object.fromEntries(
              report.risk.breakdown.map((b) => [b.category, b.score]),
            ),
            drainedAssets: report.drain.drainedAssets,
            unverifiableContracts: report.contracts.unverifiableContracts,
          } as any,
        },
      });
    } catch (err: any) {
      console.error(`[Simulation] Failed to write audit log: ${err?.message || err}`);
    }
  }

  private toStored(row: {
    id: string;
    sourceAccount: string;
    network: string;
    label: string | null;
    envelopeHash: string | null;
    score: number;
    band: string;
    blockExecution: boolean;
    indicatorCodes: string[];
    report: unknown;
    createdAt: Date;
  }): StoredSimulation {
    return {
      id: row.id,
      sourceAccount: row.sourceAccount,
      network: row.network,
      label: row.label,
      envelopeHash: row.envelopeHash,
      score: row.score,
      band: row.band,
      blockExecution: row.blockExecution,
      indicatorCodes: row.indicatorCodes,
      report: row.report,
      createdAt: row.createdAt,
    };
  }
}

export const simulationService = new SimulationService();
