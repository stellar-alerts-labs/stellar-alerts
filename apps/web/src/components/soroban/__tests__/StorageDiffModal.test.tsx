import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StorageDiffModal } from '../StorageDiffModal';
import type { ContractStorageTransactionDiff } from '../storageModel';

const onClose = vi.fn();

const diffWithChanges: ContractStorageTransactionDiff = {
  transactionHash: 'tx_abc123',
  ledger: 4_892_102,
  entries: [
    {
      id: 'vault',
      key: { type: 'Symbol', value: 'vault' },
      durability: 'persistent',
      before: { type: 'Map', value: { count: 1, owner: 'alice' } },
      after: { type: 'Map', value: { count: 2, owner: 'alice' } },
    },
  ],
};

describe('StorageDiffModal', () => {
  it('renders before/after values side by side and highlights changed lines', () => {
    render(<StorageDiffModal isOpen onClose={onClose} diff={diffWithChanges} />);

    expect(screen.getByTestId('storage-diff-modal')).toBeInTheDocument();
    expect(screen.getByTestId('diff-transaction-hash')).toHaveTextContent('tx_abc123');
    expect(screen.getByText('Ledger #4892102')).toBeInTheDocument();
    expect(screen.getByTestId('diff-status-vault')).toHaveTextContent('Modified');

    expect(screen.getByTestId('diff-before-vault')).toHaveTextContent('"count": 1');
    expect(screen.getByTestId('diff-after-vault')).toHaveTextContent('"count": 2');
    expect(screen.getByTestId('diff-line-before-vault-1')).toHaveAttribute('data-changed', 'true');
    expect(screen.getByTestId('diff-line-after-vault-1')).toHaveAttribute('data-changed', 'true');
    expect(screen.getByTestId('diff-line-before-vault-2')).toHaveAttribute('data-changed', 'false');
  });

  it('labels added, removed, and unchanged entries and shows absent sides', () => {
    const diff: ContractStorageTransactionDiff = {
      transactionHash: 'tx_kinds',
      entries: [
        {
          id: 'added',
          key: { type: 'Symbol', value: 'new_key' },
          before: null,
          after: { type: 'U32', value: 1 },
        },
        {
          id: 'removed',
          key: { type: 'Symbol', value: 'old_key' },
          before: { type: 'Symbol', value: 'old_value' },
          after: null,
        },
        {
          id: 'unchanged',
          key: { type: 'Symbol', value: 'same' },
          before: { type: 'U32', value: 1 },
          after: { type: 'U32', value: 1 },
        },
      ],
    };
    render(<StorageDiffModal isOpen onClose={onClose} diff={diff} />);

    expect(screen.getByTestId('diff-status-added')).toHaveTextContent('Added');
    expect(screen.getByTestId('diff-status-removed')).toHaveTextContent('Removed');
    expect(screen.getByTestId('diff-status-unchanged')).toHaveTextContent('Unchanged');

    expect(within(screen.getByTestId('diff-before-added')).getByText('(absent)')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('diff-after-removed')).getByText('(absent)')
    ).toBeInTheDocument();
    expect(screen.getByTestId('diff-line-before-added-0')).toHaveAttribute('data-changed', 'true');
    expect(screen.getByTestId('diff-line-after-removed-0')).toHaveAttribute('data-changed', 'true');
    expect(screen.getByTestId('diff-line-before-unchanged-0')).toHaveAttribute(
      'data-changed',
      'false'
    );
  });

  it('shows an explicit empty state for an empty diff and for no diff at all', () => {
    const { rerender } = render(
      <StorageDiffModal
        isOpen
        onClose={onClose}
        diff={{ transactionHash: 'tx_empty', entries: [] }}
      />
    );

    expect(screen.getByTestId('storage-diff-no-changes')).toHaveTextContent(
      'No storage changes were recorded for this transaction.'
    );
    expect(screen.queryByTestId('diff-entries')).not.toBeInTheDocument();

    rerender(<StorageDiffModal isOpen onClose={onClose} diff={null} />);

    expect(screen.getByTestId('storage-diff-unavailable')).toHaveTextContent(
      'No transaction diff available.'
    );
    expect(screen.queryByTestId('storage-diff-no-changes')).not.toBeInTheDocument();
  });

  it('renders nothing when closed and calls onClose from the close button', () => {
    const { rerender } = render(
      <StorageDiffModal isOpen={false} onClose={onClose} diff={diffWithChanges} />
    );
    expect(screen.queryByTestId('storage-diff-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('storage-diff-overlay')).not.toBeInTheDocument();

    rerender(<StorageDiffModal isOpen onClose={onClose} diff={diffWithChanges} />);
    fireEvent.click(screen.getByTestId('storage-diff-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
