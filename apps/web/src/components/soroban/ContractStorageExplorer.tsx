'use client';

import React, { useMemo, useState } from 'react';
import { STORAGE_DURABILITIES, formatDuration, formatScVal, getTtlHealth } from './storageModel';
import type { ContractStorageDurability, ContractStorageEntry, TtlStatus } from './storageModel';

export type {
  ContractStorageDurability,
  ContractStorageEntry,
  ContractStorageTtl,
  DecodedScVal,
  TtlHealth,
  TtlStatus,
} from './storageModel';
export {
  DEFAULT_LEDGER_CLOSE_SECONDS,
  DEFAULT_TTL_WINDOW_LEDGERS,
  formatDuration,
  formatScVal,
  getTtlHealth,
} from './storageModel';

const DURABILITY_LABELS: Record<ContractStorageDurability, string> = {
  instance: 'Instance',
  persistent: 'Persistent',
  temporary: 'Temporary',
};

const TTL_BAR_COLORS: Record<TtlStatus, string> = {
  healthy: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-rose-500',
  expired: 'bg-rose-700',
  unknown: 'bg-slate-600',
};

const TTL_TEXT_COLORS: Record<TtlStatus, string> = {
  healthy: 'text-emerald-400',
  warning: 'text-amber-400',
  critical: 'text-rose-400',
  expired: 'text-rose-400',
  unknown: 'text-slate-400',
};

export const SAMPLE_STORAGE_ENTRIES: ContractStorageEntry[] = [
  {
    id: 'instance-counter',
    durability: 'instance',
    key: { type: 'Symbol', value: 'counter' },
    value: { type: 'U32', value: 42 },
    ttl: { remainingLedgers: 518_400, totalLedgers: 518_400 },
  },
  {
    id: 'instance-admin',
    durability: 'instance',
    key: { type: 'Symbol', value: 'admin' },
    value: { type: 'Address', value: 'GADMIN...LOCAL' },
    ttl: { remainingLedgers: 259_200, totalLedgers: 518_400 },
  },
  {
    id: 'persistent-balance',
    durability: 'persistent',
    key: { type: 'Vec', value: ['balance', 'GUSER...LOCAL'] },
    value: { type: 'I128', value: '12500000' },
    ttl: { remainingLedgers: 103_680, totalLedgers: 518_400 },
  },
  {
    id: 'persistent-metadata',
    durability: 'persistent',
    key: { type: 'Symbol', value: 'metadata' },
    value: { type: 'String', value: 'v1' },
    ttl: null,
  },
  {
    id: 'temporary-oracle',
    durability: 'temporary',
    key: { type: 'Symbol', value: 'oracle_price' },
    value: { type: 'Map', value: { XLM: '0.421', USDC: '1.00' } },
    ttl: { remainingLedgers: 600, totalLedgers: 1_200 },
  },
  {
    id: 'temporary-session',
    durability: 'temporary',
    key: { type: 'Symbol', value: 'session' },
    value: { type: 'Bytes', value: '0x9f3a' },
    ttl: { remainingLedgers: 0, totalLedgers: 1_200 },
  },
];

export interface ContractStorageExplorerProps {
  entries?: ContractStorageEntry[];
  initialDurability?: ContractStorageDurability;
  /** Seconds per ledger, used for the estimated time until archival. */
  ledgerCloseSeconds?: number;
  /** 100% baseline when an entry does not declare its own TTL window. */
  defaultTtlWindowLedgers?: number;
}

function singleLinePreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim() || '—';
}

export function ContractStorageExplorer({
  entries = SAMPLE_STORAGE_ENTRIES,
  initialDurability = 'instance',
  ledgerCloseSeconds,
  defaultTtlWindowLedgers,
}: ContractStorageExplorerProps) {
  const [activeDurability, setActiveDurability] =
    useState<ContractStorageDurability>(initialDurability);
  const [filter, setFilter] = useState('');
  const [selectedEntryId, setSelectedEntryId] = useState('');

  const counts = useMemo(
    () =>
      STORAGE_DURABILITIES.reduce(
        (result, durability) => {
          result[durability] = entries.filter((entry) => entry.durability === durability).length;
          return result;
        },
        { instance: 0, persistent: 0, temporary: 0 } as Record<
          ContractStorageDurability,
          number
        >
      ),
    [entries]
  );

  const visibleEntries = useMemo(() => {
    const normalizedFilter = filter.trim().toLowerCase();
    return entries.filter((entry) => {
      if (entry.durability !== activeDurability) return false;
      if (!normalizedFilter) return true;

      const searchableText = [
        entry.id,
        entry.durability,
        entry.key.type,
        entry.value.type,
        formatScVal(entry.key),
        formatScVal(entry.value),
      ]
        .join(' ')
        .toLowerCase();
      return searchableText.includes(normalizedFilter);
    });
  }, [entries, activeDurability, filter]);

  const selectedEntry =
    visibleEntries.find((entry) => entry.id === selectedEntryId) ?? visibleEntries[0] ?? null;

  const ttlOptions = {
    ledgerCloseSeconds,
    fallbackWindowLedgers: defaultTtlWindowLedgers,
  };
  const selectedTtl = selectedEntry
    ? getTtlHealth(selectedEntry.ttl, ttlOptions)
    : getTtlHealth(null, ttlOptions);

  const remainingLabel =
    selectedTtl.remainingLedgers === null
      ? 'TTL unknown'
      : selectedTtl.status === 'expired'
        ? 'Expired · 0 ledgers remaining'
        : `${selectedTtl.remainingLedgers.toLocaleString()} ledgers remaining`;
  const estimateLabel =
    selectedTtl.remainingLedgers === null
      ? 'Archival time unknown'
      : selectedTtl.status === 'expired'
        ? 'Already expired — extend TTL to keep this entry live'
        : `${formatDuration(selectedTtl.estimatedSeconds)} until archival`;

  return (
    <div
      className="w-full rounded-xl border border-slate-800 bg-slate-900 text-slate-100 shadow-xl"
      data-testid="contract-storage-explorer"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 bg-slate-950/60 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Contract Storage Explorer</h2>
          <p className="text-xs text-slate-400">
            Browse decoded ScVal keys and values by durability tier, with TTL health until archival.
          </p>
        </div>
        <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1 font-mono text-xs text-indigo-300">
          {entries.length} total entries
        </span>
      </div>

      <div
        className="flex flex-wrap gap-1 border-b border-slate-800 px-4"
        role="tablist"
        aria-label="Storage durability tiers"
        data-testid="storage-durability-tabs"
      >
        {STORAGE_DURABILITIES.map((durability) => {
          const isActive = durability === activeDurability;
          return (
            <button
              key={durability}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls="storage-entries-panel"
              data-testid={`storage-tab-${durability}`}
              onClick={() => {
                setActiveDurability(durability);
                setSelectedEntryId('');
              }}
              className={`border-b-2 px-5 py-3 text-xs font-bold transition-colors ${
                isActive
                  ? 'border-indigo-500 bg-indigo-500/5 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {DURABILITY_LABELS[durability]}
              <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                {counts[durability]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-b border-slate-800 bg-slate-900/50 p-4">
        <label htmlFor="storage-filter" className="sr-only">
          Filter storage entries
        </label>
        <input
          id="storage-filter"
          type="search"
          data-testid="storage-filter-input"
          aria-label="Filter storage entries"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by key, value, or ScVal type..."
          className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
        />
      </div>

      <div
        id="storage-entries-panel"
        role="tabpanel"
        aria-label={`${DURABILITY_LABELS[activeDurability]} storage entries`}
        className="grid min-h-[420px] grid-cols-1 lg:grid-cols-12"
        data-testid="storage-entries-panel"
      >
        <div className="max-h-[500px] divide-y divide-slate-800/60 overflow-y-auto border-r border-slate-800 bg-slate-950/40 lg:col-span-5">
          {counts[activeDurability] === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500" data-testid="storage-list-empty">
              No {DURABILITY_LABELS[activeDurability].toLowerCase()} entries available.
            </p>
          ) : visibleEntries.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500" data-testid="storage-filter-empty">
              No storage entries match the current filter.
            </p>
          ) : (
            visibleEntries.map((entry) => {
              const isSelected = selectedEntry?.id === entry.id;
              const entryTtl = getTtlHealth(entry.ttl, ttlOptions);
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-testid={`storage-entry-${entry.id}`}
                  onClick={() => setSelectedEntryId(entry.id)}
                  className={`flex w-full flex-col gap-2 p-4 text-left transition-colors ${
                    isSelected
                      ? 'border-l-4 border-indigo-500 bg-indigo-600/10'
                      : 'hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="rounded bg-indigo-500/20 px-2 py-0.5 font-mono text-xs font-medium text-indigo-300">
                      {entry.key.type}
                    </span>
                    <span
                      className={`font-mono text-[11px] ${TTL_TEXT_COLORS[entryTtl.status]}`}
                      data-testid={`storage-entry-ttl-${entry.id}`}
                    >
                      {entryTtl.remainingLedgers === null
                        ? 'TTL unknown'
                        : `${entryTtl.remainingLedgers.toLocaleString()} ledgers`}
                    </span>
                  </div>
                  <div className="w-full truncate font-mono text-xs text-slate-200">
                    {formatScVal(entry.key)}
                  </div>
                  <div className="w-full truncate font-mono text-[11px] text-slate-500">
                    {singleLinePreview(formatScVal(entry.value))}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="max-h-[500px] space-y-5 overflow-y-auto bg-slate-900 p-6 lg:col-span-7">
          {selectedEntry ? (
            <>
              <div>
                <div className="text-xs text-slate-400">Storage key</div>
                <div
                  className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 p-3"
                  data-testid="storage-detail-key"
                >
                  <span className="rounded bg-indigo-500/20 px-2 py-0.5 font-mono text-[10px] text-indigo-300">
                    {selectedEntry.key.type}
                  </span>
                  <code className="whitespace-pre-wrap break-all font-mono text-xs text-slate-200">
                    {formatScVal(selectedEntry.key)}
                  </code>
                </div>
              </div>

              <div>
                <div className="text-xs text-slate-400">Decoded value</div>
                <div
                  className="mt-1 flex flex-wrap items-start gap-2 rounded-lg border border-slate-800 bg-slate-950 p-3"
                  data-testid="storage-detail-value"
                >
                  <span className="rounded bg-emerald-500/20 px-2 py-0.5 font-mono text-[10px] text-emerald-300">
                    {selectedEntry.value.type}
                  </span>
                  <code className="whitespace-pre-wrap break-all font-mono text-xs text-emerald-300">
                    {formatScVal(selectedEntry.value)}
                  </code>
                </div>
              </div>

              <div className="space-y-2" data-testid={`ttl-health-${selectedEntry.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    TTL health
                  </span>
                  <span
                    className={`font-mono text-xs ${TTL_TEXT_COLORS[selectedTtl.status]}`}
                    data-testid="ttl-remaining-label"
                  >
                    {remainingLabel}
                  </span>
                </div>
                <div
                  role="meter"
                  aria-label={`TTL health for ${selectedEntry.id}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={selectedTtl.percentage ?? 0}
                  aria-valuetext={selectedTtl.description}
                  data-testid={`ttl-meter-${selectedEntry.id}`}
                  className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800"
                >
                  <div
                    className={`h-full rounded-full ${TTL_BAR_COLORS[selectedTtl.status]}`}
                    data-testid={`ttl-bar-${selectedEntry.id}`}
                    style={{ width: `${selectedTtl.percentage ?? 0}%` }}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span data-testid="ttl-estimate-label">{estimateLabel}</span>
                  <span>
                    {selectedTtl.percentage === null
                      ? 'No TTL baseline available'
                      : `${selectedTtl.percentage}% of TTL window`}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <p className="p-8 text-center text-sm text-slate-500" data-testid="storage-detail-empty">
              Select a storage entry to inspect its decoded key, value, and TTL.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default ContractStorageExplorer;
