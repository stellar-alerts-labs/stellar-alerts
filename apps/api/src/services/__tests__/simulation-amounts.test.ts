import { describe, expect, it } from 'vitest';
import {
  canonicalAssetKey,
  describeAsset,
  formatRatioAsPercent,
  formatStroops,
  parseAmountToStroops,
  STROOP_PRECISION,
  STROOPS_PER_UNIT,
  tryParseAmountToStroops,
} from '../simulation/index';

/**
 * The engine's entire numeric correctness rests on these helpers: a balance that
 * is off by one stroop either hides a full drain or raises a false alarm on a
 * rounding artifact. These tests pin the exact-decimal behavior that a naive
 * `parseFloat(amount) * 1e7` would get wrong.
 */

describe('parseAmountToStroops', () => {
  it('converts whole units exactly', () => {
    expect(parseAmountToStroops('1')).toBe(10_000_000n);
    expect(parseAmountToStroops('0')).toBe(0n);
    expect(parseAmountToStroops('100')).toBe(1_000_000_000n);
  });

  it('converts fractional units without floating-point drift', () => {
    expect(parseAmountToStroops('0.0000001')).toBe(1n);
    expect(parseAmountToStroops('1.0000001')).toBe(10_000_001n);
    expect(parseAmountToStroops('0.1')).toBe(1_000_000n);
    expect(parseAmountToStroops('123.4567891')).toBe(1_234_567_891n);
  });

  it('rejects amounts with more precision than Stellar supports', () => {
    // Must throw rather than truncate: silently dropping the 8th decimal would
    // understate an outflow and could hide a drain just below the ratio gate.
    expect(() => parseAmountToStroops('0.00000001')).toThrow();
  });

  it('rejects malformed and negative amounts', () => {
    expect(() => parseAmountToStroops('')).toThrow();
    expect(() => parseAmountToStroops('-1')).toThrow();
    expect(() => parseAmountToStroops('1e7')).toThrow();
    expect(() => parseAmountToStroops('abc')).toThrow();
    expect(() => parseAmountToStroops('1.2.3')).toThrow();
    expect(() => parseAmountToStroops(' 1 ')).not.toThrow();
  });

  it('exposes precision constants consistent with Stellar (7 decimals)', () => {
    expect(STROOP_PRECISION).toBe(7);
    expect(STROOPS_PER_UNIT).toBe(10_000_000n);
  });
});

describe('tryParseAmountToStroops', () => {
  it('returns null instead of throwing on invalid input', () => {
    expect(tryParseAmountToStroops('1.5')).toBe(15_000_000n);
    expect(tryParseAmountToStroops('nope')).toBeNull();
    expect(tryParseAmountToStroops('-3')).toBeNull();
  });
});

describe('formatStroops', () => {
  it('renders stroops at fixed 7-decimal precision', () => {
    // Fixed precision (not trailing-zero-trimmed) is deliberate: an evidence
    // field should make the stroop resolution explicit so a reader can never
    // mistake "1.5" for a rounded value.
    expect(formatStroops(0n)).toBe('0.0000000');
    expect(formatStroops(1n)).toBe('0.0000001');
    expect(formatStroops(10_000_000n)).toBe('1.0000000');
    expect(formatStroops(1_234_567_891n)).toBe('123.4567891');
  });

  it('round-trips losslessly through parseAmountToStroops', () => {
    for (const amount of ['0', '1', '0.0000001', '123.4567891', '999999999.9999999']) {
      expect(parseAmountToStroops(formatStroops(parseAmountToStroops(amount)))).toBe(
        parseAmountToStroops(amount),
      );
    }
  });

  it('handles negative stroops produced by balance subtraction', () => {
    // Negatives are legitimate *outputs* (balance deltas), just never valid
    // inputs — see parseAmountToStroops.
    expect(formatStroops(-15_000_000n)).toBe('-1.5000000');
    expect(formatStroops(-1n)).toBe('-0.0000001');
  });
});

describe('formatRatioAsPercent', () => {
  it('formats a RATIO_SCALE-scaled ratio as a bare 2-decimal percent', () => {
    // RATIO_SCALE is 1e6, so ratio 1_000_000 == 100%. The `%` sign is the
    // caller's responsibility (fields are named `outflowPercent`/`sharePercent`),
    // which keeps this helper safe to embed in a sentence.
    expect(formatRatioAsPercent(1_000_000n)).toBe('100.00');
    expect(formatRatioAsPercent(850_000n)).toBe('85.00');
    expect(formatRatioAsPercent(0n)).toBe('0.00');
  });

  it('treats every input as scaled, so a small value floors to 0.00', () => {
    expect(formatRatioAsPercent(1n)).toBe('0.00');
    expect(formatRatioAsPercent(99n)).toBe('0.00');
    expect(formatRatioAsPercent(100n)).toBe('0.01');
  });

  it('renders values above 1 rather than clamping them', () => {
    // A ratio > 1 is meaningful (overdraft / debt), so it must not be silently
    // capped at 100%.
    expect(formatRatioAsPercent(1_500_000n)).toBe('150.00');
  });

  it('preserves the sign of a negative input', () => {
    expect(formatRatioAsPercent(-850_000n)).toBe('-85.00');
  });
});

describe('canonicalAssetKey', () => {
  it('produces a stable key for the native asset', () => {
    expect(canonicalAssetKey({ type: 'native' })).toBe('native');
  });

  it('distinguishes credit assets by code and issuer', () => {
    const a = canonicalAssetKey({ type: 'credit_alphanumeric', code: 'USDC', issuer: 'GAAA' });
    const b = canonicalAssetKey({ type: 'credit_alphanumeric', code: 'USDC', issuer: 'GBBB' });
    const c = canonicalAssetKey({ type: 'credit_alphanumeric', code: 'USD', issuer: 'GAAA' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(canonicalAssetKey({ type: 'credit_alphanumeric', code: 'USDC', issuer: 'GAAA' }));
  });

  it('distinguishes liquidity pools by pool id', () => {
    expect(canonicalAssetKey({ type: 'liquidity_pool', poolId: 'p1' })).not.toBe(
      canonicalAssetKey({ type: 'liquidity_pool', poolId: 'p2' }),
    );
  });

  it('does not collide with a malformed credit asset that omits its issuer', () => {
    // `USDC:` and `:GAAA` must not both collapse into the same key, or two
    // different assets would net out and cancel a detected drain.
    const a = canonicalAssetKey({ type: 'credit_alphanumeric', code: 'USDC' });
    const b = canonicalAssetKey({ type: 'credit_alphanumeric', issuer: 'GAAA' });
    expect(a).not.toBe(b);
  });
});

describe('describeAsset', () => {
  it('renders each asset type readably', () => {
    expect(describeAsset({ type: 'native' })).toBe('XLM');
    expect(describeAsset({ type: 'credit_alphanumeric', code: 'USDC', issuer: 'GAAA' })).toContain('USDC');
    expect(describeAsset({ type: 'liquidity_pool', poolId: 'p1' })).toContain('p1');
  });
});