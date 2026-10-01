import { Prisma } from '../../../generated/prisma/client';
import { prisma } from '../../lib/prisma';
import { ValidationError } from '../../lib/errors';
import {
  simulateTransactionEnvelope,
  type LedgerBaselineInput,
  type SimulationOptions,
  type SimulationReport,
  type SimulationResultInput,
} from '../../lib/tx-simulation';
import { z } from 'zod';
import { analyzeTransactionSchema } from './tx-simulation.schema';

export type AnalyzeTransactionRequest = z.infer<typeof analyzeTransactionSchema>;

export interface AnalyzeTransactionResponse {
  report: SimulationReport;
  /** Null when persistence was skipped or the audit write failed. */
  simulationId: string | null;
  /** True when no row was written (persist=false, or a non-fatal audit failure). */
  persisted: boolean;
}

/**
 * The engine compares two thresholds against 64-bit ledger values, so callers
 * can only express them as JSON numbers. Convert here rather than inside the
 * engine, which stays free of transport-shaped concerns.
 */
function toEngineOptions(options: AnalyzeTransactionRequest['options']): SimulationOptions | undefined {
  if (!options) return undefined;
  const { dustResidueStroops, cpuInstructionThreshold, ...rest } = options;
  const engineOptions: SimulationOptions = { ...rest };
  if (dustResidueStroops !== undefined) engineOptions.dustResidueStroops = BigInt(dustResidueStroops);
  if (cpuInstructionThreshold !== undefined) engineOptions.cpuInstructionThreshold = BigInt(cpuInstructionThreshold);
  return engineOptions;
}

/**
 * `DecodedEnvelope` echoes the submitted XDR so the in-memory report is
 * self-describing. That must not reach the audit row: storing it would turn
 * `TransactionSimulation` into an unscanned payload store, and the row is
 * already identified by `envelopeHash`/`innerEnvelopeHash`. The caller still
 * gets the full report (XDR included) in the HTTP response.
 */
function stripEnvelopeXdr(report: SimulationReport): Record<string, unknown> {
  const { envelopeXdr: _omitted, ...envelope } = report.envelope;
  return { ...report, envelope };
}

export class TxSimulationService {
  /**
   * Scores an envelope and (by default) records the verdict as an audit row.
   *
   * Note what this method does NOT do: it never contacts an RPC. The
   * caller supplies the `simulateTransaction` output alongside the XDR, so a
   * simulation can never be paired with a different envelope than the one
   * being scored.
   */
  async analyze(input: AnalyzeTransactionRequest, userId: string): Promise<AnalyzeTransactionResponse> {
    const simulation = (input.simulation ?? undefined) as SimulationResultInput | undefined;
    const ledgerBaseline = (input.ledgerBaseline ?? undefined) as LedgerBaselineInput | undefined;

    let report: SimulationReport;
    try {
      report = simulateTransactionEnvelope({
        envelopeXdr: input.envelopeXdr,
        networkPassphrase: input.networkPassphrase,
        simulation,
        ledgerBaseline,
        options: toEngineOptions(input.options),
      });
    } catch (err) {
      // The SDK throws bare Errors for malformed/truncated XDR. Surface it as
      // a 400 with a client-safe message rather than letting app.ts's error
      // handler turn it into an opaque 500.
      throw new ValidationError(
        'Could not decode the transaction envelope. It must be valid base64 XDR of a Stellar transaction or fee-bump envelope.',
        { reason: err instanceof Error ? err.message : String(err) },
        'INVALID_ENVELOPE_XDR',
      );
    }

    const persist = input.persist !== false;
    if (!persist) {
      return { report, simulationId: null, persisted: false };
    }

    const simulationId = await this.persistReport(report, userId, {
      networkPassphrase: input.networkPassphrase,
      hasSimulation: Boolean(simulation),
      hasLedgerBaseline: Boolean(ledgerBaseline),
    });

    return { report, simulationId, persisted: simulationId !== null };
  }

  /**
   * Writing the audit row must never fail the request it is attached to: the
   * caller asked for a verdict, and they already have it whether or not the DB
   * is reachable. A failure is logged and the response reports
   * `persisted: false` rather than the analysis being lost.
   */
  private async persistReport(
    report: SimulationReport,
    userId: string,
    requestSnapshot: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      const row = await prisma.transactionSimulation.create({
        data: {
          userId,
          envelopeHash: report.envelope.txHash,
          innerEnvelopeHash: report.envelope.innerTxHash,
          networkPassphrase: report.envelope.networkPassphrase,
          isFeeBump: report.envelope.isFeeBump,
          riskLevel: report.risk.level,
          verdict: report.risk.verdict,
          score: report.risk.score,
          indicatorCodes: report.risk.indicators.map((i) => i.code),
          // Prisma's Json columns want InputJsonValue, which a plain
          // Record<string, unknown> does not structurally satisfy. The reports
          // here are built by the engine from scalars/arrays/objects only (no
          // bigint survives JSON serialisation of the shape we store), so the
          // casts are safe rather than papering over a real mismatch.
          report: stripEnvelopeXdr(report) as Prisma.InputJsonValue,
          footprintDiff: (report.footprintDiff ?? undefined) as Prisma.InputJsonValue | undefined,
          requestSnapshot: requestSnapshot as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[TxSimulation] Failed to write simulation audit row: ${message}`);
      return null;
    }
  }
}

export const txSimulationService = new TxSimulationService();
