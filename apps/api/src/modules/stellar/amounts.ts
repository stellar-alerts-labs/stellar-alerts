/** Exact XLM amount handling for Horizon decimal strings (7 decimal places). */

export const STROOPS_PER_XLM = 10_000_000n;

/** Parses a Horizon amount (`"12.3400000"`) into stroops, exactly. Returns `null` if malformed. */
export function parseStroops(amount: string | undefined): bigint | null {
  if (typeof amount !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount.trim());
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(7, '0') || '0');
  return whole * STROOPS_PER_XLM + fraction;
}

/** Formats stroops as a 7-decimal XLM string. */
export function formatXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${whole}.${fraction}`;
}

