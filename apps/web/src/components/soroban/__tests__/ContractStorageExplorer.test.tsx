import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContractStorageExplorer } from '../ContractStorageExplorer';
import { getTtlHealth } from '../storageModel';
import type { ContractStorageEntry } from '../storageModel';

const entries: ContractStorageEntry[] = [
  {
    id: 'inst-owner',
    durability: 'instance',
    key: { type: 'Symbol', value: 'owner' },
    value: { type: 'Address', value: 'GINSTANCE' },
    ttl: { remainingLedgers: 50, totalLedgers: 100 },
  },
  {
    id: 'inst-counter',
    durability: 'instance',
    key: { type: 'Symbol', value: 'counter' },
    value: { type: 'U32', value: 7 },
    ttl: { remainingLedgers: 0, totalLedgers: 100 },
  },
  {
    id: 'persist-balance',
    durability: 'persistent',
    key: { type: 'Vec', value: ['balance', 'GUSER'] },
    value: { type: 'I128', value: '9000' },
    ttl: { remainingLedgers: 25, totalLedgers: 100 },
  },
  {
    id: 'persist-metadata',
    durability: 'persistent',
    key: { type: 'Symbol', value: 'metadata' },
    value: { type: 'String', value: 'v1' },
    ttl: null,
  },
  {
    id: 'temp-oracle',
    durability: 'temporary',
    key: { type: 'Symbol', value: 'oracle_price' },
    value: { type: 'Map', value: { XLM: '0.4' } },
    ttl: { remainingLedgers: 10, totalLedgers: 100 },
  },
];

const renderExplorer = (props: Partial<React.ComponentProps<typeof ContractStorageExplorer>> = {}) =>
  render(
    <ContractStorageExplorer
      entries={entries}
      defaultTtlWindowLedgers={100}
      {...props}
    />
  );

describe('ContractStorageExplorer', () => {
  it('renders the active durability tier with decoded key/value details and per-tier counts', () => {
    renderExplorer();

    expect(screen.getByTestId('contract-storage-explorer')).toBeInTheDocument();
    expect(screen.getByTestId('storage-tab-instance')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('storage-tab-instance')).toHaveTextContent('2');
    expect(screen.getByTestId('storage-tab-persistent')).toHaveTextContent('2');
    expect(screen.getByTestId('storage-tab-temporary')).toHaveTextContent('1');

    expect(screen.getByTestId('storage-entry-inst-owner')).toBeInTheDocument();
    expect(screen.getByTestId('storage-entry-inst-counter')).toBeInTheDocument();
    expect(screen.queryByTestId('storage-entry-persist-balance')).not.toBeInTheDocument();

    expect(screen.getByTestId('storage-detail-key')).toHaveTextContent('owner');
    expect(screen.getByTestId('storage-detail-value')).toHaveTextContent('GINSTANCE');
  });

  it('filters the list by durability tier when a tab is selected', () => {
    renderExplorer();

    fireEvent.click(screen.getByTestId('storage-tab-persistent'));

    expect(screen.getByTestId('storage-tab-persistent')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('storage-entry-persist-balance')).toBeInTheDocument();
    expect(screen.getByTestId('storage-entry-persist-metadata')).toBeInTheDocument();
    expect(screen.queryByTestId('storage-entry-inst-owner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('storage-entry-temp-oracle')).not.toBeInTheDocument();
  });

  it('filters storage entries by key/value text within the active tier', () => {
    renderExplorer({ initialDurability: 'temporary' });

    fireEvent.change(screen.getByTestId('storage-filter-input'), {
      target: { value: 'oracle' },
    });
    expect(screen.getByTestId('storage-entry-temp-oracle')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('storage-filter-input'), {
      target: { value: '9000' },
    });
    expect(screen.getByTestId('storage-filter-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('storage-entry-temp-oracle')).not.toBeInTheDocument();
  });

  it('shows an explicit empty state when a durability tier has no entries', () => {
    renderExplorer({ entries: [entries[0]], initialDurability: 'temporary' });

    expect(screen.getByTestId('storage-list-empty')).toHaveTextContent(
      'No temporary entries available.'
    );
    expect(screen.getByTestId('storage-detail-empty')).toBeInTheDocument();
  });

  it('updates the detail pane when a different storage entry is selected', () => {
    renderExplorer();

    fireEvent.click(screen.getByTestId('storage-entry-inst-counter'));

    expect(screen.getByTestId('storage-detail-key')).toHaveTextContent('counter');
    expect(screen.getByTestId('storage-detail-value')).toHaveTextContent('7');
    expect(screen.getByTestId('ttl-meter-inst-counter')).toBeInTheDocument();
  });

  it('calculates TTL percentage with clamping and treats missing data as unknown', () => {
    expect(getTtlHealth({ remainingLedgers: 25, totalLedgers: 100 }).percentage).toBe(25);
    expect(getTtlHealth({ remainingLedgers: 150, totalLedgers: 100 }).percentage).toBe(100);
    expect(getTtlHealth({ remainingLedgers: -10, totalLedgers: 100 }).percentage).toBe(0);
    expect(getTtlHealth({ remainingLedgers: 25, totalLedgers: 0 }).percentage).toBeNull();
    expect(getTtlHealth(null).percentage).toBeNull();
  });

  it('renders the TTL percentage bar and configurable estimated time until archival', () => {
    renderExplorer({ initialDurability: 'persistent', ledgerCloseSeconds: 10 });

    const meter = screen.getByTestId('ttl-meter-persist-balance');
    expect(meter).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByTestId('ttl-bar-persist-balance')).toHaveStyle({ width: '25%' });
    expect(screen.getByTestId('ttl-remaining-label')).toHaveTextContent(
      '25 ledgers remaining'
    );
    expect(screen.getByTestId('ttl-estimate-label')).toHaveTextContent(
      '4m 10s until archival'
    );
  });

  it('renders zero TTL as expired and unknown TTL without a fabricated percentage', () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('storage-entry-inst-counter'));

    expect(screen.getByTestId('ttl-remaining-label')).toHaveTextContent(
      'Expired · 0 ledgers remaining'
    );
    expect(screen.getByTestId('ttl-estimate-label')).toHaveTextContent('Already expired');
    expect(screen.getByTestId('ttl-meter-inst-counter')).toHaveAttribute('aria-valuenow', '0');
  });

  it('renders a null TTL as unknown instead of treating it as expired', () => {
    renderExplorer({ initialDurability: 'persistent' });

    fireEvent.click(screen.getByTestId('storage-entry-persist-metadata'));

    expect(screen.getByTestId('ttl-remaining-label')).toHaveTextContent('TTL unknown');
    expect(screen.getByTestId('ttl-estimate-label')).toHaveTextContent('Archival time unknown');
    expect(screen.getByTestId('ttl-meter-persist-metadata')).toHaveAttribute(
      'aria-valuetext',
      'TTL unknown'
    );
    expect(screen.getByTestId('ttl-bar-persist-metadata')).toHaveStyle({ width: '0%' });
  });
});
