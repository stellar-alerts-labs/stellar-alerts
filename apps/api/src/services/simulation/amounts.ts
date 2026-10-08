/**
 * Exact decimal helpers for Stellar/Soroban amounts.
 *
 * Every Stellar amount (XLM and every credit balance) has at most 7 decimal
 * places, so amounts are normalized to integer **stroops** (`1 XLM = 10_000_000`
 * stroops) and compared/arithmetic-done in `bigint`. This is deliberate: a
 * pre-execution risk engine that decides "did this envelope move the whole
 * balance?" cannot afford IEEE-754 rounding, and `0.1 + 0.2 !== 0.3` in binary
 * floating point would make both the drain detector and the reported score
 * subtly wrong for exact-balance drains — the single most important case this
 * engine has to get right.
 *
 * `parseAmountToStroops` rejects anything it can't represent exactly (more than
 * 7 decimal places, exponent notation, non-numeric text) rather than silently
 * rounding, so a malformed amount surfaces as a validation error instead of a
 * wrong risk decision.
 */

import type { AssetRef } from './types';

/** Number of decimal places Stellar supports for any amount. */
export const STROOP_PRECISION = 7;

/** Smallest addressable unit; 10^7 stroops == 1 XLM. */
export const STROOPS_PER_UNIT = 10n ** BigInt(STROOP_PRECISION);

// Unsigned by design: every Stellar amount that appears on the wire (balances,
// trustline limits, operation amounts, clawback targets) is non-negative.
// Negatives in a report are *derived* — they come from subtracting two balances
// in the drain detector, never from parsing caller input. Accepting a leading
// '-' here would let a malformed or hostile request supply an amount that nets
// against a real outflow and shrinks a detected drain ratio.
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Converts a decimal amount string to integer stroops, exactly.
 *
 * @throws {RangeError} when the string is not a plain non-negative decimal
 *   number, carries more than 7 decimal places, or is not representable as a
 *   `bigint`.
 */
export function parseAmountToStroops(amount: string | number | bigint): bigint {
  if (typeof amount === 'bigint') {
    // A negative bigint can only come from caller code that already did the
    // arithmetic; allow it through so internal deltas remain expressible.
    return amount;
  }

  const text = typeof amount === 'number' ? numberToDecimalString(amount) : amount.trim();

  if (!DECIMAL_PATTERN.test(text)) {
    throw new RangeError(`Amount is not a plain non-negative decimal number: "${text}"`);
  }

  const [wholePart = '0', fractionPart = ''] = text.split('.');

  if (fractionPart.length > STROOP_PRECISION) {
    throw new RangeError(
      `Amount "${text}" has ${fractionPart.length} decimal places; Stellar amounts support at most ${STROOP_PRECISION}`,
    );
  }

  const paddedFraction = fractionPart.padEnd(STROOP_PRECISION, '0');
  return BigInt(`${wholePart}${paddedFraction}`);
}

/**
 * Non-throwing variant of {@link parseAmountToStroops}: returns `null` instead
 * of throwing so callers in a detection path can treat an unparsable amount as
 * "unknown" and keep scoring the rest of the envelope.
 */
export function tryParseAmountToStroops(amount: string | number | bigint | null | undefined): bigint | null {
  if (amount === null || amount === undefined || amount === '') return null;
  try {
    return parseAmountToStroops(amount);
  } catch {
    return null;
  }
}

/**
 * Renders integer stroops as a fixed 7-decimal-place string. Never uses
 * floating point, so the output round-trips back through
 * {@link parseAmountToStroops} to the identical `bigint`.
 */
export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const fraction = (abs % STROOPS_PER_UNIT).toString().padStart(STROOP_PRECISION, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Formats a ratio in `[0, 1+]` as a 2-decimal percentage string for reports.
 * `ratio` is expected to be a `bigint` scaled by `RATIO_SCALE` so that a
 * balance comparison stays exact.
 */
export const RATIO_SCALE = 1_000_000n;

export function formatRatioAsPercent(ratioScaled: bigint): string {
  const negative = ratioScaled < 0n;
  const abs = negative ? -ratioScaled : ratioScaled;
  // Two decimal places of a percent: (ratioScaled / RATIO_SCALE) * 100.
  const hundredths = (abs * 10_000n) / RATIO_SCALE;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Converts `Number` amounts to a decimal string without going through
 * `toString()`'s exponent form for large values (e.g. `1e-7`).
 */
function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Amount is not a finite number: ${String(value)}`);
  }
  if (Number.isInteger(value)) return value.toFixed(0);
  return value.toFixed(STROOP_PRECISION).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Canonical, stable identity for an asset, used as a `Record`/comparison key.
 * `code` is upper-cased because Stellar asset codes are case-insensitive on the
 * wire; issuer keys are case-sensitive (Base32) and left untouched.
 */
export function canonicalAssetKey(asset: AssetRef): string {
  switch (asset.type) {
    case 'native':
      return 'native';
    case 'credit_alphanumeric':
      return `credit_alphanumeric:${(asset.code ?? '').toUpperCase()}:${asset.issuer ?? ''}`;
    case 'liquidity_pool': {
      const poolId = asset.poolId ?? asset.code;
      return `liquidity_pool:${poolId ?? ''}`;
    }
    default:
      return `unknown:${JSON.stringify(asset)}`;
  }
}

/** Human-facing label for an asset, used in indicator messages. */
export function describeAsset(asset: AssetRef): string {
  switch (asset.type) {
    case 'native':
      return 'XLM';
    case 'credit_alphanumeric':
      return `${(asset.code ?? '???').toUpperCase()} (${asset.issuer ?? 'unknown issuer'})`;
    case 'liquidity_pool':
      return `liquidity pool ${asset.poolId ?? asset.code ?? 'unknown'}`;
    default:
      return 'unknown asset';
  }
}
