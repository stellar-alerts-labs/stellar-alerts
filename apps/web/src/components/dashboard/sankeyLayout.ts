export type SankeyNodeRole = 'source' | 'pool' | 'destination';
export type SankeyMetric = 'amount' | 'fee';

export interface PathPaymentHop {
  id?: string;
  poolId: string;
  poolLabel?: string;
  fromAsset: string;
  fromAmount?: number;
  toAsset: string;
  toAmount?: number;
  feeAsset?: string;
  feeAmount?: number;
}

export interface PathPaymentFlow {
  id: string;
  txHash?: string;
  ledger?: number;
  sourceAsset: string;
  sourceAmount: number;
  destinationAsset: string;
  destinationAmount: number;
  hops?: PathPaymentHop[];
}

export interface NormalizedPathPaymentHop {
  id: string;
  index: number;
  poolId: string;
  poolLabel: string;
  fromAsset: string;
  fromAmount: number;
  toAsset: string;
  toAmount: number;
  feeAsset: string;
  feeAmount: number;
  feeBps: number;
}

export interface NormalizedPathPaymentFlow {
  id: string;
  txHash?: string;
  ledger?: number;
  sourceAsset: string;
  sourceAmount: number;
  destinationAsset: string;
  destinationAmount: number;
  hops: NormalizedPathPaymentHop[];
  feesByAsset: Record<string, number>;
}

export interface SankeyNode {
  id: string;
  role: SankeyNodeRole;
  asset: string;
  label: string;
  poolId?: string;
  column: number;
  value: number;
  feeValue: number;
  flowIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SankeyLink {
  id: string;
  flowId: string;
  hopIndex: number;
  sourceId: string;
  targetId: string;
  sourceLabel: string;
  targetLabel: string;
  metric: SankeyMetric;
  value: number;
  amount: number;
  asset: string;
  feeAsset: string;
  feeAmount: number;
  color: string;
  thickness: number;
  d: string;
}

export interface SankeyGraph {
  nodes: SankeyNode[];
  links: SankeyLink[];
  columns: number;
  width: number;
  height: number;
  maxColumnValue: number;
}

export interface SankeyMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

type PendingLink = Omit<SankeyLink, 'd' | 'thickness' | 'color'>;

export interface SankeyLayoutOptions {
  width: number;
  height: number;
  nodeWidth?: number;
  nodePadding?: number;
  margin?: Partial<SankeyMargin>;
  minNodeThickness?: number;
  metric?: SankeyMetric;
}

const ASSET_PALETTE = [
  '#22d3ee',
  '#a78bfa',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#60a5fa',
  '#fb7185',
  '#4ade80',
];

export const POOL_COLOR = '#818cf8';

export const DEFAULT_SANKEY_MARGIN: SankeyMargin = {
  top: 28,
  right: 96,
  bottom: 28,
  left: 96,
};

export function colorForAsset(asset: string): string {
  const key = (asset || 'XLM').toUpperCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 1000003;
  }
  return ASSET_PALETTE[hash % ASSET_PALETTE.length];
}

const toFiniteNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveNumber = (value: unknown, fallback: number): number => {
  const parsed = toFiniteNumber(value, fallback);
  return parsed > 0 ? parsed : fallback;
};

const toNonNegativeNumber = (value: unknown, fallback: number): number => {
  const parsed = toFiniteNumber(value, fallback);
  return parsed >= 0 ? parsed : fallback;
};

export function calculateFeeBps(feeAmount: number, amount: number): number {
  if (!Number.isFinite(feeAmount) || !Number.isFinite(amount) || amount <= 0) return 0;
  return (Math.abs(feeAmount) / amount) * 10000;
}

export function formatSankeyAmount(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 });
}

export function formatSankeyFeeBps(bps: number): string {
  return `${(Number.isFinite(bps) ? bps : 0).toFixed(1)} bps`;
}

export function normalizePathPaymentFlow(flow: PathPaymentFlow, index = 0): NormalizedPathPaymentFlow {
  const flowId = flow?.id ?? `flow-${index}`;
  const sourceAsset = (flow?.sourceAsset || 'XLM').toUpperCase();
  const destinationAsset = (flow?.destinationAsset || 'XLM').toUpperCase();
  const rawHops = (flow?.hops ?? []).filter((hop) => Boolean(hop && hop.poolId));

  const feesByAsset: Record<string, number> = {};
  let previousToAmount = toPositiveNumber(flow?.sourceAmount, 0);

  const hops: NormalizedPathPaymentHop[] = rawHops.map((hop, hopIndex) => {
    const isLastHop = hopIndex === rawHops.length - 1;
    const fromAsset = (hop.fromAsset || sourceAsset).toUpperCase();
    const toAsset = (hop.toAsset || (isLastHop ? destinationAsset : fromAsset)).toUpperCase();
    const fromAmount = toPositiveNumber(hop.fromAmount, previousToAmount);
    const toAmount = toPositiveNumber(hop.toAmount, fromAmount);
    const feeAmount = toNonNegativeNumber(hop.feeAmount, 0);
    const feeAsset = (hop.feeAsset || fromAsset).toUpperCase();

    feesByAsset[feeAsset] = (feesByAsset[feeAsset] ?? 0) + feeAmount;
    previousToAmount = toAmount;

    return {
      id: hop.id ?? `${flowId}-hop-${hopIndex}`,
      index: hopIndex,
      poolId: hop.poolId,
      poolLabel: hop.poolLabel ?? hop.poolId,
      fromAsset,
      fromAmount,
      toAsset,
      toAmount,
      feeAsset,
      feeAmount,
      feeBps: calculateFeeBps(feeAmount, fromAmount),
    };
  });

  const sourceAmount = toPositiveNumber(flow?.sourceAmount, hops[0]?.fromAmount ?? 0);
  const destinationAmount = toPositiveNumber(
    flow?.destinationAmount,
    hops[hops.length - 1]?.toAmount ?? sourceAmount,
  );

  return {
    id: flowId,
    txHash: flow?.txHash,
    ledger: flow?.ledger,
    sourceAsset,
    sourceAmount,
    destinationAsset,
    destinationAmount,
    hops,
    feesByAsset,
  };
}

export function isRenderableFlow(flow: NormalizedPathPaymentFlow): boolean {
  if (flow.hops.length === 0) return flow.destinationAmount > 0;
  const firstHop = flow.hops[0];
  const lastHop = flow.hops[flow.hops.length - 1];
  return firstHop.fromAmount > 0 && lastHop.toAmount > 0;
}

export function countPathPaymentHops(flows: PathPaymentFlow[]): number {
  return flows.reduce((total, flow) => total + (flow?.hops?.length ?? 0), 0);
}

export function summarizePathPaymentFees(
  flows: PathPaymentFlow[],
): { asset: string; amount: number }[] {
  const totals = new Map<string, number>();
  flows.forEach((flow, index) => {
    const normalized = normalizePathPaymentFlow(flow, index);
    Object.entries(normalized.feesByAsset).forEach(([asset, amount]) => {
      totals.set(asset, (totals.get(asset) ?? 0) + amount);
    });
  });
  return Array.from(totals.entries())
    .filter(([, amount]) => amount > 0)
    .map(([asset, amount]) => ({ asset, amount }))
    .sort((a, b) => b.amount - a.amount);
}

const poolKey = (hop: NormalizedPathPaymentHop): string =>
  `pool:${hop.poolId}|${hop.fromAsset}>${hop.toAsset}`;

export function describeSankeyNode(node: SankeyNode): string {
  if (node.role === 'pool') {
    return `${node.label} DEX pool delivering ${node.asset}`;
  }
  return `${node.role === 'source' ? 'Source' : 'Destination'} asset ${node.asset}`;
}

export function describeSankeyLink(link: SankeyLink): string {
  if (link.hopIndex < 0) {
    return `Settlement of ${formatSankeyAmount(link.amount)} ${link.asset} into ${link.targetLabel}`;
  }
  return `Hop ${link.hopIndex + 1} into ${link.targetLabel}: ${formatSankeyAmount(link.amount)} ${link.asset}, fee ${formatSankeyAmount(link.feeAmount)} ${link.feeAsset}`;
}

export function buildSankeyGraph(
  flows: PathPaymentFlow[],
  options: SankeyLayoutOptions,
): SankeyGraph {
  const width = Math.max(options.width, 1);
  const height = Math.max(options.height, 1);
  const metric = options.metric ?? 'amount';
  const nodeWidth = options.nodeWidth ?? 16;
  const nodePadding = options.nodePadding ?? 18;
  const minNodeThickness = options.minNodeThickness ?? 6;
  const margin: SankeyMargin = { ...DEFAULT_SANKEY_MARGIN, ...(options.margin ?? {}) };

  const normalized = flows
    .map((flow, index) => normalizePathPaymentFlow(flow, index))
    .filter(isRenderableFlow);

  const nodeMap = new Map<string, SankeyNode & { inValue: number; outValue: number }>();
  const pendingLinks: PendingLink[] = [];

  const ensureNode = (
    column: number,
    role: SankeyNodeRole,
    asset: string,
    key: string,
    label: string,
    flowId: string,
    poolId?: string,
  ): SankeyNode & { inValue: number; outValue: number } => {
    const id = `${column}::${key}`;
    const existing = nodeMap.get(id);
    if (existing) {
      if (!existing.flowIds.includes(flowId)) existing.flowIds.push(flowId);
      return existing;
    }
    const created = {
      id,
      role,
      asset,
      label,
      poolId,
      column,
      value: 0,
      feeValue: 0,
      flowIds: [flowId],
      x: 0,
      y: 0,
      width: nodeWidth,
      height: 0,
      inValue: 0,
      outValue: 0,
    };
    nodeMap.set(id, created);
    return created;
  };

  normalized.forEach((flow) => {
    const sourceNode = ensureNode(
      0,
      'source',
      flow.sourceAsset,
      `source:${flow.sourceAsset}`,
      flow.sourceAsset,
      flow.id,
    );

    let previousNodeId = sourceNode.id;
    let previousLabel = flow.sourceAsset;
    let previousColumn = 0;
    let previousAsset = flow.sourceAsset;

    flow.hops.forEach((hop) => {
      const column = previousColumn + 1;
      const poolNode = ensureNode(
        column,
        'pool',
        hop.toAsset,
        poolKey(hop),
        hop.poolLabel,
        flow.id,
        hop.poolId,
      );
      poolNode.feeValue += hop.feeAmount;

      pendingLinks.push({
        id: `${flow.id}::link-${hop.index}`,
        flowId: flow.id,
        hopIndex: hop.index,
        sourceId: previousNodeId,
        targetId: poolNode.id,
        sourceLabel: previousLabel,
        targetLabel: hop.poolLabel,
        metric,
        value: metric === 'fee' ? hop.feeAmount : hop.fromAmount,
        amount: hop.fromAmount,
        asset: previousAsset,
        feeAsset: hop.feeAsset,
        feeAmount: hop.feeAmount,
      });

      previousNodeId = poolNode.id;
      previousColumn = column;
      previousLabel = hop.poolLabel;
      previousAsset = hop.toAsset;
    });

    const destinationColumn = previousColumn + 1;
    const destinationNode = ensureNode(
      destinationColumn,
      'destination',
      flow.destinationAsset,
      `destination:${flow.destinationAsset}`,
      flow.destinationAsset,
      flow.id,
    );

    pendingLinks.push({
      id: `${flow.id}::link-final`,
      flowId: flow.id,
      hopIndex: -1,
      sourceId: previousNodeId,
      targetId: destinationNode.id,
      sourceLabel: previousLabel,
      targetLabel: flow.destinationAsset,
      metric,
      value: metric === 'fee' ? 0 : flow.destinationAmount,
      amount: flow.destinationAmount,
      asset: previousAsset,
      feeAsset: previousAsset,
      feeAmount: 0,
    });
  });

  const nodes = Array.from(nodeMap.values());
  const columnCount = nodes.reduce((max, node) => Math.max(max, node.column + 1), 0);

  pendingLinks.forEach((link) => {
    const sourceNode = nodeMap.get(link.sourceId);
    const targetNode = nodeMap.get(link.targetId);
    if (sourceNode) sourceNode.outValue += link.value;
    if (targetNode) targetNode.inValue += link.value;
  });
  nodes.forEach((node) => {
    node.value = Math.max(node.inValue, node.outValue);
  });

  const columns: SankeyNode[][] = Array.from({ length: columnCount }, () => []);
  nodes.forEach((node) => columns[node.column].push(node));
  columns.forEach((column) => {
    column.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  });

  const maxNodesInColumn = columns.reduce((max, column) => Math.max(max, column.length), 0);
  const maxColumnValue = columns.reduce(
    (max, column) => Math.max(max, column.reduce((sum, node) => sum + node.value, 0)),
    0,
  );

  const innerWidth = Math.max(width - margin.left - margin.right, 1);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 1);
  const columnGap = (length: number) => Math.max(length - 1, 0) * nodePadding;

  const heightFor = (value: number, ky: number) => Math.max(value * ky, minNodeThickness);
  const thicknessFor = (value: number, ky: number) => Math.max(value * ky, 1);

  const columnSpan = (ky: number) =>
    columns.reduce(
      (max, column) => Math.max(max, column.reduce((sum, node) => sum + heightFor(node.value, ky), 0) + columnGap(column.length)),
      0,
    );

  const paddingReserve = columnGap(maxNodesInColumn);
  let scale = maxColumnValue > 0 ? Math.max(innerHeight - paddingReserve, 1) / maxColumnValue : 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const span = columnSpan(scale);
    if (span <= innerHeight || span <= 0) break;
    scale = (scale * innerHeight) / span;
  }

  const inStack = new Map<string, number>();
  const outStack = new Map<string, number>();
  pendingLinks.forEach((link) => {
    const thickness = thicknessFor(link.value, scale);
    outStack.set(link.sourceId, (outStack.get(link.sourceId) ?? 0) + thickness);
    inStack.set(link.targetId, (inStack.get(link.targetId) ?? 0) + thickness);
  });

  const step = columnCount > 1 ? innerWidth / (columnCount - 1) : 0;
  columns.forEach((column, columnIndex) => {
    const x =
      columnCount > 1
        ? margin.left + columnIndex * step
        : margin.left + (innerWidth - nodeWidth) / 2;

    const heights = column.map((node) =>
      Math.max(
        heightFor(node.value, scale),
        inStack.get(node.id) ?? 0,
        outStack.get(node.id) ?? 0,
      ),
    );

    let cursor = margin.top + (innerHeight - (heights.reduce((sum, h) => sum + h, 0) + columnGap(column.length))) / 2;
    column.forEach((node, nodeIndex) => {
      node.x = x;
      node.y = cursor;
      node.width = nodeWidth;
      node.height = heights[nodeIndex];
      cursor += node.height + nodePadding;
    });
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const endpointSort = (side: 'out' | 'in') => (a: PendingLink, b: PendingLink) => {
    const aNode = nodeById.get(side === 'out' ? a.targetId : a.sourceId);
    const bNode = nodeById.get(side === 'out' ? b.targetId : b.sourceId);
    if (!aNode || !bNode) return 0;
    return aNode.y - bNode.y || a.id.localeCompare(b.id);
  };

  const outgoing = new Map<string, PendingLink[]>();
  const incoming = new Map<string, PendingLink[]>();
  pendingLinks.forEach((link) => {
    outgoing.set(link.sourceId, [...(outgoing.get(link.sourceId) ?? []), link]);
    incoming.set(link.targetId, [...(incoming.get(link.targetId) ?? []), link]);
  });

  const ribbonY = new Map<string, number>();
  const stackRibbons = (source: Map<string, PendingLink[]>, side: 'out' | 'in') => {
    source.forEach((unsorted, nodeId) => {
      const node = nodeById.get(nodeId);
      if (!node) return;
      const sorted = [...unsorted].sort(endpointSort(side));
      const thicknesses = sorted.map((link) => Math.max(link.value * scale, 1));
      const stackTotal = thicknesses.reduce((sum, thickness) => sum + thickness, 0);
      let cursor = node.y + (node.height - stackTotal) / 2;
      sorted.forEach((link, index) => {
        ribbonY.set(`${link.id}::${side}`, cursor);
        cursor += thicknesses[index];
      });
    });
  };
  stackRibbons(outgoing, 'out');
  stackRibbons(incoming, 'in');

  const links: SankeyLink[] = pendingLinks.map((link) => {
    const sourceNode = nodeById.get(link.sourceId);
    const targetNode = nodeById.get(link.targetId);
    const thickness = Math.max(link.value * scale, 1);
    const x0 = (sourceNode?.x ?? 0) + (sourceNode?.width ?? 0);
    const x1 = targetNode?.x ?? 0;
    const midX = x0 + (x1 - x0) / 2;
    const y0 = ribbonY.get(`${link.id}::out`) ?? sourceNode?.y ?? 0;
    const y1 = ribbonY.get(`${link.id}::in`) ?? targetNode?.y ?? 0;
    const bottom0 = y0 + thickness;
    const bottom1 = y1 + thickness;

    const d = [
      `M${x0},${y0}`,
      `C${midX},${y0} ${midX},${y1} ${x1},${y1}`,
      `L${x1},${bottom1}`,
      `C${midX},${bottom1} ${midX},${bottom0} ${x0},${bottom0}`,
      'Z',
    ].join(' ');

    const color = targetNode?.role === 'pool' ? POOL_COLOR : colorForAsset(link.asset);

    return { ...link, thickness, color, d };
  });

  return {
    nodes,
    links,
    columns: columnCount,
    width,
    height,
    maxColumnValue,
  };
}
