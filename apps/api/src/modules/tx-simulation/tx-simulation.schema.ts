import { z } from 'zod';

/**
 * Upper bound on the base64 envelope we'll accept, in *characters* (a b64
 * string is ~4/3 the size of the XDR it decodes to, so this is roughly
 * `TX_SIMULATION_MAX_ENVELOPE_BYTES` worth of decoded XDR plus slack).
 *
 * Exported as a constant rather than read from `config/env` because this
 * module is imported by `openapi.config.ts`, which must stay free of env
 * validation/DB/Redis — see that file's header comment. `config/env.ts`
 * documents the operator-facing knob; `tx-simulation.schema.test.ts` asserts
 * the two stay in agreement so they cannot drift.
 */
export const MAX_ENVELOPE_XDR_CHARS = 512_000;

/**
 * Request schema for POST /tx-simulation/analyze.
 *
 * The whole point of the endpoint is to score an envelope the caller is
 * *about to* submit, so the request is shaped around what the engine needs
 * rather than around any single transport: the envelope is the only required
 * field, and everything else only sharpens the analysis (see `coverage` in
 * the response — a missing `simulation` block means no footprint diff).
 *
 * Strict at every level: an unrecognised key is a client typo (most likely a
 * misspelled `ledgerBaseline` field) or an attempt to smuggle in data we would
 * silently ignore, and silently ignoring it would quietly lower `coverage`
 * without telling anyone. A 400 naming the offending key is the safer answer.
 */
export const analyzeTransactionSchema = z
  .object({
    /** Base64 XDR of the transaction envelope (or fee-bump envelope) to analyze. */
    envelopeXdr: z.string().min(1).max(MAX_ENVELOPE_XDR_CHARS),

    networkPassphrase: z.string().min(1).max(64),

    /**
     * Result of `simulateTransaction`, forwarded from the caller's own RPC.
     * We deliberately do not call an RPC here: the engine is pure, and
     * re-simulating server-side would let a caller pair a simulation from one
     * envelope with the XDR of a different one.
     */
    simulation: z
      .object({
        status: z.string().min(1).max(64).optional(),
        costCpuInsns: z.string().max(40).optional(),
        costMemBytes: z.string().max(40).optional(),
        readOnlyLedgerKeys: z.array(z.string().min(1)).max(2000).optional(),
        readWriteLedgerKeys: z.array(z.string().min(1)).max(2000).optional(),
        archivedLedgerKeys: z.array(z.string().min(1)).max(2000).optional(),
        restoreRequired: z.boolean().optional(),
      })
      .strict()
      .nullish(),

    /**
     * Caller-known ledger facts. Without a balance the engine skips
     * balance-relative drain math, so an absent `nativeBalanceStroops` lowers
     * `coverage.balanceBaseline` rather than failing the request.
     */
    ledgerBaseline: z
      .object({
        nativeBalanceStroops: z.string().max(40).optional(),
        knownRecipients: z.array(z.string().min(1)).max(2000).optional(),
        trustedContracts: z.array(z.string().min(1)).max(2000).optional(),
      })
      .strict()
      .nullish(),

    /**
     * Per-request threshold overrides. Omitted fields fall back to
     * DEFAULT_SIMULATION_THRESHOLDS. Bounded generously — these are ratios and
     * counts, and a caller sending 1e9 just gets an engine that flags
     * everything rather than a way to bypass detection.
     *
     * `dustResidueStroops` and `cpuInstructionThreshold` arrive as JS numbers
     * and are widened to bigint by the service, since the engine compares them
     * against 64-bit ledger values.
     */
    options: z
      .object({
        drainExhaustionRatio: z.coerce.number().positive().max(1000).optional(),
        drainSplitDestinationThreshold: z.coerce.number().int().min(2).max(1000).optional(),
        dustResidueStroops: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        ttlExtensionLedgerThreshold: z.coerce.number().int().min(1).max(10_000_000).optional(),
        cpuInstructionThreshold: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
        maxFootprintEntries: z.coerce.number().int().min(1).max(100_000).optional(),
        pathPaymentAsymmetryRatio: z.coerce.number().positive().max(1000).optional(),
        footprintExpansionRatio: z.coerce.number().positive().max(1000).optional(),
      })
      .strict()
      .nullish(),

    /**
     * Set false to skip writing the audit row (e.g. a caller dry-running many
     * candidate envelopes). Defaults to true.
     */
    persist: z.boolean().optional(),
  })
  .strict();
