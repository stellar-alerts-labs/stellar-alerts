/**
 * Shared, framework-free model and helpers for Soroban contract storage views.
 * Keeping these pure makes the UI components easy to test with injected data.
 */

export const STORAGE_DURABILITIES = ['instance', 'persistent', 'temporary'] as const;

export type ContractStorageDurability = (typeof STORAGE_DURABILITIES)[number];

export const DEFAULT_LEDGER_CLOSE_SECONDS = 5;
/** Generic 30-day window used only when an entry does not provide its own TTL window. */
export const DEFAULT_TTL_WINDOW_LEDGERS = 518_400;

export interface DecodedScVal {
  type: string;
  value: unknown;
  xdrBase64?: string;
}

export interface ContractStorageTtl {
  /** Ledgers left before archival. `null` means the RPC did not return a TTL. */
  remainingLedgers: number | null;
  /** Full TTL window represented by 100% of the health bar. */
  totalLedgers?: number | null;
}

export interface ContractStorageEntry {
  id: string;
  durability: ContractStorageDurability;
  key: DecodedScVal;
  value: DecodedScVal;
  ttl?: ContractStorageTtl | null;
}

export interface ContractStorageDiffEntry {
  id: string;
  key: DecodedScVal;
  durability?: ContractStorageDurability;
  before: DecodedScVal | null;
  after: DecodedScVal | null;
}

export interface ContractStorageTransactionDiff {
  transactionHash: string;
  ledger?: number;
  entries: ContractStorageDiffEntry[];
}

export type TtlStatus = 'healthy' | 'warning' | 'critical' | 'expired' | 'unknown';

export interface TtlHealth {
  remainingLedgers: number | null;
  percentage: number | null;
  estimatedSeconds: number | null;
  status: TtlStatus;
  description: string;
}

export interface TtlHealthOptions {
  ledgerCloseSeconds?: number;
  fallbackWindowLedgers?: number;
}

export type StorageDiffKind = 'added' | 'removed' | 'modified' | 'unchanged';

export interface DiffLine {
  text: string;
  changed: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Render a decoded ScVal as stable, readable text for both list and diff views. */
export function formatScVal(value: DecodedScVal | null | undefined): string {
  if (!value) return '(absent)';
  if (typeof value.value === 'string') return value.value;
  if (value.value === null || value.value === undefined) return '—';

  try {
    return (
      JSON.stringify(
        value.value,
        (_key, item) => (typeof item === 'bigint' ? item.toString() : item),
        2
      ) ?? String(value.value)
    );
  } catch {
    // Defensive fallback for non-serializable values supplied by a caller.
    return String(value.value);
  }
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!isFiniteNumber(seconds)) return 'unknown';

  const total = Math.max(0, Math.floor(seconds));
  if (total === 0) return '0s';

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const remainderSeconds = total % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainderSeconds}s`;
  return `${remainderSeconds}s`;
}

/**
 * Calculate health for a TTL bar. Unknown/invalid data yields a null percentage
 * instead of pretending that the entry is expired.
 */
export function getTtlHealth(
  ttl: ContractStorageTtl | null | undefined,
  options: TtlHealthOptions = {}
): TtlHealth {
  const ledgerCloseSeconds =
    isFiniteNumber(options.ledgerCloseSeconds) && options.ledgerCloseSeconds > 0
      ? options.ledgerCloseSeconds
      : DEFAULT_LEDGER_CLOSE_SECONDS;
  const fallbackWindow =
    isFiniteNumber(options.fallbackWindowLedgers) && options.fallbackWindowLedgers > 0
      ? options.fallbackWindowLedgers
      : DEFAULT_TTL_WINDOW_LEDGERS;

  const rawRemaining = ttl?.remainingLedgers;
  if (!isFiniteNumber(rawRemaining)) {
    return {
      remainingLedgers: null,
      percentage: null,
      estimatedSeconds: null,
      status: 'unknown',
      description: 'TTL unknown',
    };
  }

  const remainingLedgers = Math.max(0, Math.floor(rawRemaining));
  const rawWindow = ttl?.totalLedgers ?? fallbackWindow;
  const windowLedgers = isFiniteNumber(rawWindow) && rawWindow > 0 ? rawWindow : null;
  const percentage =
    windowLedgers === null
      ? null
      : Math.min(100, Math.max(0, Math.round((remainingLedgers / windowLedgers) * 100)));

  const estimatedSeconds = remainingLedgers * ledgerCloseSeconds;
  const duration = formatDuration(estimatedSeconds);
  const status: TtlStatus =
    remainingLedgers === 0
      ? 'expired'
      : percentage === null
        ? 'unknown'
        : percentage >= 50
          ? 'healthy'
          : percentage >= 20
            ? 'warning'
            : 'critical';

  const description =
    status === 'expired'
      ? 'Expired · 0 ledgers remaining'
      : status === 'unknown'
        ? `TTL unknown · ${remainingLedgers.toLocaleString()} ledgers remaining`
        : `${status} · ${remainingLedgers.toLocaleString()} ledgers · ${duration} until archival`;

  return { remainingLedgers, percentage, estimatedSeconds, status, description };
}

function scValSignature(value: DecodedScVal): string {
  return `${value.type}:${formatScVal(value)}`;
}

export function getDiffKind(
  before: DecodedScVal | null,
  after: DecodedScVal | null
): StorageDiffKind {
  if (!before && !after) return 'unchanged';
  if (!before) return 'added';
  if (!after) return 'removed';
  return scValSignature(before) === scValSignature(after) ? 'unchanged' : 'modified';
}

/**
 * Index-aligned line comparison. Decoded JSON values keep a stable line order,
 * so this highlights changed fields without pulling in a diff dependency.
 */
export function getDiffLines(
  before: DecodedScVal | null,
  after: DecodedScVal | null
): { before: DiffLine[]; after: DiffLine[] } {
  const beforeLines = formatScVal(before).split('\n');
  const afterLines = formatScVal(after).split('\n');
  const lineCount = Math.max(beforeLines.length, afterLines.length);

  return {
    before: Array.from({ length: lineCount }, (_, index) => {
      const text = beforeLines[index] ?? '';
      return { text, changed: text !== (afterLines[index] ?? '') };
    }),
    after: Array.from({ length: lineCount }, (_, index) => {
      const text = afterLines[index] ?? '';
      return { text, changed: text !== (beforeLines[index] ?? '') };
    }),
  };
}
