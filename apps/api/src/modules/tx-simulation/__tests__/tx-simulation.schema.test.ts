import { describe, expect, it } from 'vitest';
import { env } from '../../../config/env';
import { analyzeTransactionSchema, MAX_ENVELOPE_XDR_CHARS } from '../tx-simulation.schema';

describe('MAX_ENVELOPE_XDR_CHARS', () => {
  /**
   * `tx-simulation.schema.ts` cannot import `config/env` — it is loaded by
   * `openapi.config.ts`, which the shared type generator imports specifically
   * to avoid env validation/Postgres/Redis (see that file's header). So the
   * size cap is duplicated as a literal, and this test is the thing that stops
   * the two from drifting apart.
   *
   * b64 encodes 3 bytes as 4 chars, so the char cap must be at least 4/3 of
   * the operator-facing byte budget for the advertised limit to be honest.
   */
  it('is consistent with the TX_SIMULATION_MAX_ENVELOPE_BYTES budget', () => {
    const byteBudget = env.TX_SIMULATION_MAX_ENVELOPE_BYTES;
    expect(MAX_ENVELOPE_XDR_CHARS).toBeGreaterThanOrEqual(Math.ceil((byteBudget * 4) / 3));
  });
});

describe('analyzeTransactionSchema', () => {
  const base = { envelopeXdr: 'AAAA', networkPassphrase: 'Test SDF Network ; September 2015' };

  it('requires only the envelope and passphrase', () => {
    const parsed = analyzeTransactionSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown top-level fields', () => {
    expect(analyzeTransactionSchema.safeParse({ ...base, nope: 1 }).success).toBe(false);
  });

  it('rejects unknown nested fields', () => {
    expect(
      analyzeTransactionSchema.safeParse({ ...base, ledgerBaseline: { nope: 1 } }).success,
    ).toBe(false);
    expect(analyzeTransactionSchema.safeParse({ ...base, simulation: { nope: 1 } }).success).toBe(false);
    expect(analyzeTransactionSchema.safeParse({ ...base, options: { nope: 1 } }).success).toBe(false);
  });

  it('accepts explicit nulls for the optional blocks', () => {
    const parsed = analyzeTransactionSchema.safeParse({
      ...base,
      simulation: null,
      ledgerBaseline: null,
      options: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('enforces the envelope size cap', () => {
    expect(analyzeTransactionSchema.safeParse({ ...base, envelopeXdr: 'A'.repeat(MAX_ENVELOPE_XDR_CHARS) }).success).toBe(true);
    expect(analyzeTransactionSchema.safeParse({ ...base, envelopeXdr: 'A'.repeat(MAX_ENVELOPE_XDR_CHARS + 1) }).success).toBe(false);
  });

  it('bounds the threshold overrides so they cannot disable detection', () => {
    const absurd = analyzeTransactionSchema.safeParse({
      ...base,
      options: {
        drainExhaustionRatio: 1e12,
        maxFootprintEntries: 10 ** 9,
        drainSplitDestinationThreshold: 1,
      },
    });
    expect(absurd.success).toBe(false);
  });

  it('coerces numeric strings for the bigint-backed thresholds', () => {
    const parsed = analyzeTransactionSchema.safeParse({
      ...base,
      options: { dustResidueStroops: '1000', cpuInstructionThreshold: '5000' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.options?.dustResidueStroops).toBe(1000);
      expect(parsed.data.options?.cpuInstructionThreshold).toBe(5000);
    }
  });
});
