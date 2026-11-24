'use client';

import React from 'react';
import { formatScVal, getDiffKind, getDiffLines } from './storageModel';
import type {
  ContractStorageTransactionDiff,
  DiffLine,
  StorageDiffKind,
} from './storageModel';

export type {
  ContractStorageDiffEntry,
  ContractStorageTransactionDiff,
  DecodedScVal,
  DiffLine,
  StorageDiffKind,
} from './storageModel';

const DIFF_STATUS_LABELS: Record<StorageDiffKind, string> = {
  added: 'Added',
  removed: 'Removed',
  modified: 'Modified',
  unchanged: 'Unchanged',
};

const DIFF_STATUS_CLASSES: Record<StorageDiffKind, string> = {
  added: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  removed: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  modified: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  unchanged: 'bg-slate-800 text-slate-400 border-slate-700',
};

export interface StorageDiffModalProps {
  isOpen: boolean;
  onClose: () => void;
  diff: ContractStorageTransactionDiff | null;
}

interface DiffPaneProps {
  side: 'before' | 'after';
  entryId: string;
  lines: DiffLine[];
}

function DiffPane({ side, entryId, lines }: DiffPaneProps) {
  const isBefore = side === 'before';
  return (
    <div
      className="min-w-0 rounded-lg border border-slate-800 bg-slate-950"
      data-testid={`diff-${side}-${entryId}`}
    >
      <div className="border-b border-slate-800 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {isBefore ? 'Before' : 'After'}
      </div>
      <div className="space-y-0.5 p-3 font-mono text-xs">
        {lines.map((line, index) => (
          <div
            key={index}
            data-testid={`diff-line-${side}-${entryId}-${index}`}
            data-changed={line.changed ? 'true' : 'false'}
            className={`whitespace-pre rounded px-1 ${
              line.changed
                ? isBefore
                  ? 'bg-rose-500/20 text-rose-300'
                  : 'bg-emerald-500/20 text-emerald-300'
                : 'text-slate-300'
            }`}
          >
            {line.text || '\u00a0'}
          </div>
        ))}
      </div>
    </div>
  );
}

export function StorageDiffModal({ isOpen, onClose, diff }: StorageDiffModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="storage-diff-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-diff-title"
        data-testid="storage-diff-modal"
        className="max-h-[85vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-100 shadow-2xl"
      >
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h2 id="storage-diff-title" className="text-lg font-semibold text-white">
              Transaction Storage Diff
            </h2>
            {diff ? (
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span>Tx</span>
                <code className="font-mono text-indigo-300" data-testid="diff-transaction-hash">
                  {diff.transactionHash}
                </code>
                {diff.ledger !== undefined && (
                  <span className="font-mono">Ledger #{diff.ledger}</span>
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close storage diff"
            data-testid="storage-diff-close"
            onClick={onClose}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700"
          >
            Close
          </button>
        </div>

        {!diff ? (
          <p className="py-10 text-center text-sm text-slate-500" data-testid="storage-diff-unavailable">
            No transaction diff available.
          </p>
        ) : diff.entries.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500" data-testid="storage-diff-no-changes">
            No storage changes were recorded for this transaction.
          </p>
        ) : (
          <div className="space-y-4" data-testid="diff-entries">
            {diff.entries.map((entry) => {
              const kind = getDiffKind(entry.before, entry.after);
              const lines = getDiffLines(entry.before, entry.after);
              return (
                <section
                  key={entry.id}
                  className="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
                  data-testid={`diff-entry-${entry.id}`}
                >
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-xs text-slate-400">Key</span>
                      <code className="break-all font-mono text-xs text-slate-200">
                        {formatScVal(entry.key)}
                      </code>
                      {entry.durability && (
                        <span className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                          {entry.durability}
                        </span>
                      )}
                    </div>
                    <span
                      className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${DIFF_STATUS_CLASSES[kind]}`}
                      data-testid={`diff-status-${entry.id}`}
                    >
                      {DIFF_STATUS_LABELS[kind]}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <DiffPane side="before" entryId={entry.id} lines={lines.before} />
                    <DiffPane side="after" entryId={entry.id} lines={lines.after} />
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default StorageDiffModal;
