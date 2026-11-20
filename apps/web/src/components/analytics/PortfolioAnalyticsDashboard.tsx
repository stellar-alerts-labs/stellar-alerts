'use client';

import React, { useCallback, useMemo, useState } from 'react';
import type { PaymentDTO, WalletDTO } from '@stellar-alerts/shared';
import { NetFlowChart, type NetFlowDay } from './NetFlowChart';
import { getAssetColor } from './MoneyFlowGraph';

export interface PortfolioAnalyticsDashboardProps {
  wallets: WalletDTO[];
  payments: PaymentDTO[];
  selectedTags?: string[];
}

interface BalanceByAsset {
  [asset: string]: number;
}

interface NetFlowData {
  date: string;
  inflow: number;
  outflow: number;
  netChange: number;
}

function parsePaymentDate(payment: PaymentDTO): Date | null {
  const value = payment.receivedAt ?? payment.createdAt;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function aggregateBalancesByAsset(
  wallets: WalletDTO[],
  payments: PaymentDTO[],
  selectedWalletIds?: string[]
): BalanceByAsset {
  const result: BalanceByAsset = {};

  // Filter wallets
  const relevantWallets = selectedWalletIds
    ? wallets.filter((w) => selectedWalletIds.includes(w.id))
    : wallets;

  const relevantWalletIds = new Set(relevantWallets.map((w) => w.id));

  // Sum inflows for each wallet
  for (const payment of payments) {
    if (!relevantWalletIds.has(payment.walletId)) continue;

    const asset = payment.asset || 'XLM';
    result[asset] = (result[asset] ?? 0) + Number(payment.amount ?? 0);
  }

  return result;
}

function computeNetFlowData(
  payments: PaymentDTO[],
  selectedWalletIds?: string[],
  days = 30
): NetFlowDay[] {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  const buckets = new Map<string, { inflow: number; outflow: number }>();

  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + offset);
    const key = toDateKey(day);
    buckets.set(key, { inflow: 0, outflow: 0 });
  }

  const selectedWalletIdSet = selectedWalletIds ? new Set(selectedWalletIds) : null;

  for (const payment of payments) {
    if (selectedWalletIdSet && !selectedWalletIdSet.has(payment.walletId)) continue;

    const date = parsePaymentDate(payment);
    if (!date) continue;

    const key = toDateKey(date);
    const bucket = buckets.get(key);
    if (!bucket) continue;

    const amount = Number(payment.amount ?? 0);
    bucket.inflow += amount;
  }

  return Array.from(buckets, ([date, { inflow, outflow }]) => ({
    date,
    inflow,
    outflow,
    netChange: inflow - outflow,
  }));
}

function getAllUniqueTags(wallets: WalletDTO[]): string[] {
  const tags = new Set<string>();
  for (const wallet of wallets) {
    if (wallet.tags) {
      wallet.tags.forEach((tag) => tags.add(tag));
    }
  }
  return Array.from(tags).sort();
}

function getWalletIdsByTags(wallets: WalletDTO[], selectedTags: string[]): string[] {
  if (selectedTags.length === 0) return wallets.map((w) => w.id);

  return wallets
    .filter((wallet) => {
      if (!wallet.tags) return false;
      return selectedTags.some((tag) => wallet.tags?.includes(tag));
    })
    .map((w) => w.id);
}

export const PortfolioAnalyticsDashboard: React.FC<PortfolioAnalyticsDashboardProps> = ({
  wallets,
  payments,
  selectedTags = [],
}) => {
  const [dateRangeDays, setDateRangeDays] = useState(30);
  const [activeTagFilter, setActiveTagFilter] = useState<string[]>(selectedTags);
  const [startDateFilter, setStartDateFilter] = useState<string | null>(null);
  const [endDateFilter, setEndDateFilter] = useState<string | null>(null);

  // Get all available tags
  const allTags = useMemo(() => getAllUniqueTags(wallets), [wallets]);

  // Get selected wallet IDs based on tag filter
  const selectedWalletIds = useMemo(
    () => getWalletIdsByTags(wallets, activeTagFilter),
    [wallets, activeTagFilter]
  );

  // Filter payments by date range if specified
  const dateFilteredPayments = useMemo(() => {
    if (!startDateFilter && !endDateFilter) return payments;

    const startDate = startDateFilter ? new Date(startDateFilter) : null;
    const endDate = endDateFilter ? new Date(endDateFilter) : null;

    return payments.filter((p) => {
      const pDate = parsePaymentDate(p);
      if (!pDate) return false;
      if (startDate && pDate < startDate) return false;
      if (endDate && pDate > endDate) return false;
      return true;
    });
  }, [payments, startDateFilter, endDateFilter]);

  // Aggregate balances across selected wallets
  const aggregatedBalances = useMemo(
    () => aggregateBalancesByAsset(wallets, dateFilteredPayments, selectedWalletIds),
    [wallets, dateFilteredPayments, selectedWalletIds]
  );

  // Calculate net flow data
  const netFlowData = useMemo(
    () => computeNetFlowData(dateFilteredPayments, selectedWalletIds, dateRangeDays),
    [dateFilteredPayments, selectedWalletIds, dateRangeDays]
  );

  // Total portfolio value
  const totalPortfolioValue = useMemo(
    () => Object.values(aggregatedBalances).reduce((sum, val) => sum + val, 0),
    [aggregatedBalances]
  );

  // Asset allocation for donut chart
  const assetAllocation = useMemo(
    () =>
      Object.entries(aggregatedBalances)
        .sort(([, a], [, b]) => b - a)
        .map(([asset, balance]) => ({
          asset,
          balance,
          percentage: totalPortfolioValue > 0 ? (balance / totalPortfolioValue) * 100 : 0,
        })),
    [aggregatedBalances, totalPortfolioValue]
  );

  // CSV export handler
  const handleExportCSV = useCallback(() => {
    const rows: string[] = [];

    // Header
    rows.push('Date,Inflow,Outflow,Net Change');

    // Data rows
    for (const day of netFlowData) {
      rows.push(`${day.date},${day.inflow},${day.outflow},${day.netChange}`);
    }

    // Asset allocation section
    rows.push('');
    rows.push('Asset,Balance,Percentage');
    for (const asset of assetAllocation) {
      rows.push(`${asset.asset},${asset.balance.toFixed(2)},${asset.percentage.toFixed(2)}%`);
    }

    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `portfolio-statement-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [netFlowData, assetAllocation]);

  // Toggle tag filter
  const toggleTag = useCallback((tag: string) => {
    setActiveTagFilter((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }, []);

  return (
    <div className="w-full max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white mb-1">Portfolio Analytics</h1>
          <p className="text-sm text-slate-400">
            Aggregate balances and historical net-flow analysis across monitored wallets
          </p>
        </div>
        <button
          onClick={handleExportCSV}
          className="px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          📥 Export CSV
        </button>
      </div>

      {/* Filters Section */}
      <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/40 backdrop-blur-sm space-y-4">
        {/* Tag Filters */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
            Wallet Tags
          </h3>
          <div className="flex flex-wrap gap-2">
            {allTags.length === 0 ? (
              <span className="text-xs text-slate-500 italic">No tags available</span>
            ) : (
              allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    activeTagFilter.includes(tag)
                      ? 'bg-sky-500/20 border-sky-400 text-sky-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tag}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Date Range Presets */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
            Net-Flow Period
          </h3>
          <div className="flex flex-wrap gap-2">
            {[
              { days: 7, label: '7 days' },
              { days: 14, label: '14 days' },
              { days: 30, label: '30 days' },
              { days: 90, label: '90 days' },
            ].map(({ days, label }) => (
              <button
                key={days}
                onClick={() => setDateRangeDays(days)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  dateRangeDays === days
                    ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Date Range Inputs */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
              From
            </label>
            <input
              type="date"
              value={startDateFilter || ''}
              onChange={(e) => setStartDateFilter(e.target.value || null)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
              To
            </label>
            <input
              type="date"
              value={endDateFilter || ''}
              onChange={(e) => setEndDateFilter(e.target.value || null)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>
        </div>
      </div>

      {/* Portfolio Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-lg border border-slate-800 bg-slate-900/60 backdrop-blur-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Total Value
          </div>
          <div className="text-2xl font-bold text-white font-mono">
            {totalPortfolioValue.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {selectedWalletIds.length} wallet{selectedWalletIds.length !== 1 ? 's' : ''}
          </div>
        </div>

        <div className="p-4 rounded-lg border border-slate-800 bg-slate-900/60 backdrop-blur-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Assets
          </div>
          <div className="text-2xl font-bold text-white">{assetAllocation.length}</div>
          <div className="text-xs text-slate-400 mt-1">Unique asset types</div>
        </div>

        <div className="p-4 rounded-lg border border-slate-800 bg-slate-900/60 backdrop-blur-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Total Inflows
          </div>
          <div className="text-2xl font-bold text-emerald-400 font-mono">
            {netFlowData.reduce((sum, d) => sum + d.inflow, 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-xs text-slate-400 mt-1">Last {dateRangeDays} days</div>
        </div>

        <div className="p-4 rounded-lg border border-slate-800 bg-slate-900/60 backdrop-blur-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Total Outflows
          </div>
          <div className="text-2xl font-bold text-red-400 font-mono">
            {netFlowData.reduce((sum, d) => sum + d.outflow, 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </div>
          <div className="text-xs text-slate-400 mt-1">Last {dateRangeDays} days</div>
        </div>
      </div>

      {/* Net Flow Chart */}
      <div className="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden shadow-lg">
        <div className="p-4 border-b border-slate-800 bg-slate-900/40">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span aria-hidden="true">📊</span> Net Flow ({dateRangeDays}-Day)
          </h2>
          <p className="text-xs text-slate-400 mt-1">Daily inflow vs outflow volume</p>
        </div>
        <NetFlowChart data={netFlowData} height={450} selectedTags={activeTagFilter} />
      </div>

      {/* Asset Allocation */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Donut Chart */}
        <div className="lg:col-span-2 rounded-xl border border-slate-800 bg-slate-950 overflow-hidden shadow-lg p-6">
          <h2 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
            <span aria-hidden="true">🎯</span> Asset Allocation
          </h2>
          {assetAllocation.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-slate-500">
              <span className="text-sm">No asset data available</span>
            </div>
          ) : (
            <div className="space-y-3">
              {assetAllocation.map((asset) => (
                <div key={asset.asset} className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-4 h-4 rounded-full" style={{ backgroundColor: getAssetColor(asset.asset) }} />
                  <div className="flex-1">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm font-medium text-slate-200">{asset.asset}</span>
                      <span className="text-xs font-mono text-slate-400">
                        {asset.balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full transition-all duration-300"
                        style={{
                          backgroundColor: getAssetColor(asset.asset),
                          width: `${asset.percentage}%`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-slate-500 mt-1 block">
                      {asset.percentage.toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Stats Panel */}
        <div className="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden shadow-lg p-6">
          <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
            <span aria-hidden="true">📈</span> Summary
          </h2>
          <div className="space-y-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
                Selected Wallets
              </div>
              <div className="text-2xl font-bold text-sky-400">{selectedWalletIds.length}</div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
                Payment Records
              </div>
              <div className="text-2xl font-bold text-emerald-400">
                {dateFilteredPayments.length.toLocaleString()}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">
                Filter Tags
              </div>
              <div className="flex flex-wrap gap-1">
                {activeTagFilter.length === 0 ? (
                  <span className="text-xs text-slate-500 italic">All wallets</span>
                ) : (
                  activeTagFilter.map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-1 rounded-md bg-sky-500/20 text-sky-300 text-xs border border-sky-500/30"
                    >
                      {tag}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PortfolioAnalyticsDashboard;
