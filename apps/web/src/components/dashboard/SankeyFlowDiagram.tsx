import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildSankeyGraph,
  colorForAsset,
  countPathPaymentHops,
  describeSankeyLink,
  describeSankeyNode,
  formatSankeyAmount,
  formatSankeyFeeBps,
  normalizePathPaymentFlow,
  POOL_COLOR,
  summarizePathPaymentFees,
} from './sankeyLayout';
import type { PathPaymentFlow, SankeyMetric, SankeyNode } from './sankeyLayout';
import { SAMPLE_PATH_PAYMENT_FLOWS } from './sankeySampleData';

export interface SankeyFlowDiagramProps {
  flows: PathPaymentFlow[];
  isLoading?: boolean;
  height?: number;
}

interface NodeLabelPlacement {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  showValue: boolean;
}

const METRIC_LABELS: Record<SankeyMetric, string> = {
  amount: 'Flow amount',
  fee: 'Hop fees',
};

const placeNodeLabel = (node: SankeyNode, columnCount: number): NodeLabelPlacement => {
  if (node.column === 0) {
    return { x: node.x - 10, y: node.y + node.height / 2 - 2, anchor: 'end', showValue: true };
  }
  if (node.column === columnCount - 1) {
    return { x: node.x + node.width + 10, y: node.y + node.height / 2 - 2, anchor: 'start', showValue: true };
  }
  return { x: node.x + node.width / 2, y: node.y - 8, anchor: 'middle', showValue: false };
};

const useMeasuredWidth = (fallback: number) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(Math.round(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
};

export const SankeyFlowDiagram: React.FC<SankeyFlowDiagramProps> = ({
  flows = [],
  isLoading = false,
  height = 420,
}) => {
  const { ref: containerRef, width } = useMeasuredWidth(960);
  const [metric, setMetric] = useState<SankeyMetric>('amount');
  const [useSampleData, setUseSampleData] = useState(false);
  const [flowFilter, setFlowFilter] = useState('all');
  const [activeLinkId, setActiveLinkId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [pinnedFlowId, setPinnedFlowId] = useState<string | null>(null);

  const availableFlows = useSampleData && flows.length === 0 ? SAMPLE_PATH_PAYMENT_FLOWS : flows;

  const normalizedFlows = useMemo(
    () => availableFlows.map((flow, index) => normalizePathPaymentFlow(flow, index)),
    [availableFlows],
  );

  const selectedFlowId = normalizedFlows.some((flow) => flow.id === flowFilter) ? flowFilter : 'all';

  const visibleFlows = useMemo(
    () =>
      selectedFlowId === 'all'
        ? availableFlows
        : availableFlows.filter((flow) => flow.id === selectedFlowId),
    [availableFlows, selectedFlowId],
  );

  const graph = useMemo(
    () => buildSankeyGraph(visibleFlows, { width, height, metric }),
    [visibleFlows, width, height, metric],
  );

  const feeTotals = useMemo(() => summarizePathPaymentFees(availableFlows), [availableFlows]);
  const totalHops = useMemo(() => countPathPaymentHops(availableFlows), [availableFlows]);

  const activeLink = useMemo(
    () => graph.links.find((link) => link.id === activeLinkId) ?? null,
    [graph.links, activeLinkId],
  );

  const highlightedFlowId = pinnedFlowId ?? activeLink?.flowId ?? null;
  const isDimmed = highlightedFlowId !== null || activeNodeId !== null;

  useEffect(() => {
    if (!isDimmed) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setActiveLinkId(null);
      setActiveNodeId(null);
      setPinnedFlowId(null);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isDimmed]);

  const clearHighlight = () => {
    setActiveLinkId(null);
    setActiveNodeId(null);
    setPinnedFlowId(null);
  };

  const resetSelection = () => {
    clearHighlight();
    setFlowFilter('all');
  };

  const togglePinned = (flowId: string) => {
    setPinnedFlowId((current) => (current === flowId ? null : flowId));
  };

  const linkOpacity = (flowId: string, sourceId: string, targetId: string) => {
    if (highlightedFlowId && flowId !== highlightedFlowId) return 0.1;
    if (activeNodeId && sourceId !== activeNodeId && targetId !== activeNodeId) return 0.1;
    return highlightedFlowId || activeNodeId ? 0.9 : 0.75;
  };

  const nodeOpacity = (flowIds: string[]) =>
    highlightedFlowId && !flowIds.includes(highlightedFlowId) ? 0.2 : 1;

  if (isLoading) {
    return (
      <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 backdrop-blur-xl shadow-xl">
        <p className="p-12 text-center text-slate-400 text-sm">Loading path payment routes...</p>
      </div>
    );
  }

  if (availableFlows.length === 0) {
    return (
      <div
        className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 backdrop-blur-xl shadow-xl space-y-4"
        data-testid="sankey-empty-state"
      >
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span>🔀</span> Multi-Hop Path Flow
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Sankey view of asset conversion steps, intermediate DEX pools, and hop fees.
          </p>
        </div>
        <div className="p-10 text-center rounded-xl bg-slate-950/40 border border-slate-800/80 space-y-3">
          <p className="text-slate-300 text-sm font-medium">
            No multi-hop path payment routes recorded yet.
          </p>
          <p className="text-slate-500 text-xs">
            This visualization renders once a path payment route reaches the dashboard.
          </p>
          <button
            type="button"
            data-testid="sankey-load-sample"
            onClick={() => setUseSampleData(true)}
            className="inline-flex items-center gap-2 px-4 py-2 mt-2 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20 text-xs font-semibold transition-colors cursor-pointer"
          >
            Preview sample route
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 backdrop-blur-xl shadow-xl space-y-6"
    >
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span>🔀</span> Multi-Hop Path Flow
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Each ribbon is one conversion step. Hover, focus, or select a ribbon to isolate its
            route and hop fees.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div
            className="flex items-center gap-1 p-1 rounded-xl bg-slate-950 border border-slate-800"
            role="group"
            aria-label="Ribbon sizing metric"
          >
            {(Object.keys(METRIC_LABELS) as SankeyMetric[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMetric(option)}
                aria-pressed={metric === option}
                data-testid={`sankey-metric-${option}`}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  metric === option ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {METRIC_LABELS[option]}
              </button>
            ))}
          </div>

          {normalizedFlows.length > 1 && (
            <select
              aria-label="Path payment route"
              data-testid="sankey-flow-select"
              value={selectedFlowId}
              onChange={(event) => setFlowFilter(event.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              <option value="all">All path payments</option>
              {normalizedFlows.map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.sourceAsset} → {flow.destinationAsset} · {flow.hops.length}{' '}
                  {flow.hops.length === 1 ? 'hop' : 'hops'}
                </option>
              ))}
            </select>
          )}

          {flows.length === 0 && (
            <button
              type="button"
              onClick={() => {
                setUseSampleData(false);
                clearHighlight();
              }}
              data-testid="sankey-clear-sample"
              className="px-3 py-2 rounded-lg bg-slate-800/60 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-300 transition-colors cursor-pointer"
            >
              Exit sample preview
            </button>
          )}

          {isDimmed && (
            <button
              type="button"
              onClick={resetSelection}
              data-testid="sankey-reset"
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-300 transition-colors cursor-pointer"
            >
              Reset selection
            </button>
          )}
        </div>
      </div>

      {/* Summary Strip */}
      <div className="flex flex-wrap items-center gap-3" data-testid="sankey-summary">
        <div className="text-xs text-slate-400 font-mono bg-slate-800/50 px-3 py-1.5 rounded-lg border border-slate-700/50">
          <span className="text-indigo-400 font-semibold">{normalizedFlows.length}</span> path
          {normalizedFlows.length === 1 ? '' : 's'} ·{' '}
          <span className="text-indigo-400 font-semibold">{totalHops}</span> hop
          {totalHops === 1 ? '' : 's'}
        </div>
        {feeTotals.map((fee) => (
          <div
            key={fee.asset}
            className="text-xs font-mono bg-slate-800/50 px-3 py-1.5 rounded-lg border border-slate-700/50"
          >
            <span className="text-amber-400 font-semibold">{formatSankeyAmount(fee.amount)}</span>{' '}
            <span className="text-slate-400">{fee.asset} fees</span>
          </div>
        ))}
        {useSampleData && flows.length === 0 && (
          <span className="text-[11px] font-semibold text-amber-400/90 bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 rounded-lg">
            Sample route data
          </span>
        )}
      </div>

      {/* Diagram */}
      <div className="rounded-2xl bg-slate-950/50 border border-slate-800/80 p-2">
        {graph.links.length === 0 ? (
          <p className="p-12 text-center text-slate-500 text-sm">
            This route has no convertible hops to plot.
          </p>
        ) : (
          <svg
            data-testid="sankey-svg"
            role="group"
            aria-label="Sankey diagram of multi-hop path payment flows"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-auto select-none"
          >
            <defs>
              <filter id="sankey-ribbon-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {graph.links.map((link) => {
              const isActive = link.id === activeLinkId;
              return (
                <path
                  key={link.id}
                  d={link.d}
                  data-testid="sankey-ribbon"
                  data-flow-id={link.flowId}
                  role="button"
                  tabIndex={0}
                  aria-label={describeSankeyLink(link)}
                  aria-pressed={pinnedFlowId === link.flowId}
                  fill={link.color}
                  fillOpacity={linkOpacity(link.flowId, link.sourceId, link.targetId)}
                  stroke={isActive ? '#ffffff' : 'transparent'}
                  strokeWidth={isActive ? 1.25 : 0}
                  filter={isActive ? 'url(#sankey-ribbon-glow)' : undefined}
                  className="cursor-pointer focus:outline-none focus-visible:stroke-white"
                  onMouseEnter={() => setActiveLinkId(link.id)}
                  onMouseLeave={() =>
                    setActiveLinkId((current) => (current === link.id ? null : current))
                  }
                  onFocus={() => setActiveLinkId(link.id)}
                  onBlur={() =>
                    setActiveLinkId((current) => (current === link.id ? null : current))
                  }
                  onClick={() => togglePinned(link.flowId)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    togglePinned(link.flowId);
                  }}
                />
              );
            })}

            {graph.nodes.map((node) => {
              const placement = placeNodeLabel(node, graph.columns);
              const label = placement.showValue ? node.asset : node.label;

              return (
                <g
                  key={node.id}
                  data-testid="sankey-node"
                  data-node-role={node.role}
                  opacity={nodeOpacity(node.flowIds)}
                  className="transition-opacity duration-200"
                >
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={node.height}
                    rx={4}
                    fill={node.role === 'pool' ? POOL_COLOR : colorForAsset(node.asset)}
                    className="cursor-pointer"
                    onMouseEnter={() => setActiveNodeId(node.id)}
                    onMouseLeave={() =>
                      setActiveNodeId((current) => (current === node.id ? null : current))
                    }
                  >
                    <title>{describeSankeyNode(node)}</title>
                  </rect>
                  <text
                    x={placement.x}
                    y={placement.y}
                    textAnchor={placement.anchor}
                    fontSize={11}
                    fontWeight={600}
                    fill={node.role === 'pool' ? '#c7d2fe' : '#e2e8f0'}
                    className="pointer-events-none"
                  >
                    {label}
                  </text>
                  {placement.showValue && metric === 'amount' && (
                    <text
                      x={placement.x}
                      y={placement.y + 13}
                      textAnchor={placement.anchor}
                      fontSize={10}
                      fill="#64748b"
                      className="pointer-events-none font-mono"
                    >
                      {formatSankeyAmount(node.value)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-slate-400" aria-hidden="true" />
          Source asset
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="w-3 h-3 rounded-sm"
            style={{ backgroundColor: POOL_COLOR }}
            aria-hidden="true"
          />
          Intermediate DEX pool
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-emerald-400" aria-hidden="true" />
          Destination asset
        </span>
        <span className="text-slate-500">
          {metric === 'fee'
            ? 'Ribbon width is scaled to hop fee size.'
            : 'Ribbon width is scaled to traded amount.'}
        </span>
      </div>

      {/* Hop Breakdown */}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-left text-xs border-collapse" data-testid="sankey-hop-table">
          <thead>
            <tr className="bg-slate-950/60 text-slate-400 uppercase tracking-wider text-[10px]">
              {normalizedFlows.length > 1 && <th className="py-2.5 px-3">Route</th>}
              <th className="py-2.5 px-3">Hop</th>
              <th className="py-2.5 px-3">DEX Pool</th>
              <th className="py-2.5 px-3">In</th>
              <th className="py-2.5 px-3">Out</th>
              <th className="py-2.5 px-3">Hop Fee</th>
              <th className="py-2.5 px-3">Fee Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 text-slate-300">
            {normalizedFlows.flatMap((flow) =>
              flow.hops.length === 0 ? (
                <tr key={flow.id} data-testid="sankey-direct-row">
                  {normalizedFlows.length > 1 && (
                    <td className="px-3 py-2.5 font-mono text-slate-400">{flow.id}</td>
                  )}
                  <td className="px-3 py-2.5 text-slate-400" colSpan={6}>
                    Direct transfer, no conversion hops.
                  </td>
                </tr>
              ) : (
                flow.hops.map((hop) => (
                  <tr
                    key={hop.id}
                    data-testid="sankey-hop-row"
                    className={
                      highlightedFlowId && highlightedFlowId !== flow.id
                        ? 'opacity-40'
                        : 'hover:bg-slate-800/30 transition-colors'
                    }
                  >
                    {normalizedFlows.length > 1 && (
                      <td className="px-3 py-2.5 font-mono text-slate-400">{flow.id}</td>
                    )}
                    <td className="px-3 py-2.5 font-semibold text-indigo-400">{hop.index + 1}</td>
                    <td className="px-3 py-2.5">
                      <span className="px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                        {hop.poolLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono">
                      {formatSankeyAmount(hop.fromAmount)} {hop.fromAsset}
                    </td>
                    <td className="px-3 py-2.5 font-mono">
                      {formatSankeyAmount(hop.toAmount)} {hop.toAsset}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-amber-400">
                      {formatSankeyAmount(hop.feeAmount)} {hop.feeAsset}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-400">
                      {formatSankeyFeeBps(hop.feeBps)}
                    </td>
                  </tr>
                ))
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
