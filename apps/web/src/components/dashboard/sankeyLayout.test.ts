import { describe, it, expect } from 'vitest';
import {
  buildSankeyGraph,
  calculateFeeBps,
  colorForAsset,
  countPathPaymentHops,
  isRenderableFlow,
  normalizePathPaymentFlow,
  summarizePathPaymentFees,
} from './sankeyLayout';
import type { PathPaymentFlow } from './sankeyLayout';
import { SAMPLE_PATH_PAYMENT_FLOWS } from './sankeySampleData';

const TWO_HOP: PathPaymentFlow = {
  id: 'flow-a',
  sourceAsset: 'XLM',
  sourceAmount: 10000,
  destinationAsset: 'EURC',
  destinationAmount: 2238.75,
  hops: [
    {
      poolId: 'xlm-usdc',
      poolLabel: 'XLM/USDC',
      fromAsset: 'XLM',
      fromAmount: 10000,
      toAsset: 'USDC',
      toAmount: 2450,
      feeAsset: 'XLM',
      feeAmount: 5,
    },
    {
      poolId: 'usdc-eurc',
      poolLabel: 'USDC/EURC',
      fromAsset: 'USDC',
      fromAmount: 2450,
      toAsset: 'EURC',
      toAmount: 2238.75,
      feeAsset: 'USDC',
      feeAmount: 1.225,
    },
  ],
};

const ONE_HOP: PathPaymentFlow = {
  id: 'flow-b',
  sourceAsset: 'XLM',
  sourceAmount: 5000,
  destinationAsset: 'USDC',
  destinationAmount: 1225,
  hops: [
    {
      poolId: 'xlm-usdc',
      poolLabel: 'XLM/USDC',
      fromAsset: 'XLM',
      fromAmount: 5000,
      toAsset: 'USDC',
      toAmount: 1225,
      feeAsset: 'XLM',
      feeAmount: 2.5,
    },
  ],
};

const build = (flows: PathPaymentFlow[], metric: 'amount' | 'fee' = 'amount') =>
  buildSankeyGraph(flows, { width: 960, height: 420, metric });

describe('normalizePathPaymentFlow', () => {
  it('uppercases assets and assigns stable hop ids', () => {
    const normalized = normalizePathPaymentFlow(TWO_HOP);

    expect(normalized.sourceAsset).toBe('XLM');
    expect(normalized.destinationAsset).toBe('EURC');
    expect(normalized.hops.map((hop) => hop.id)).toEqual(['flow-a-hop-0', 'flow-a-hop-1']);
    expect(normalized.hops.map((hop) => hop.poolLabel)).toEqual(['XLM/USDC', 'USDC/EURC']);
  });

  it('chains missing hop amounts from the previous hop output', () => {
    const normalized = normalizePathPaymentFlow({
      id: 'flow-sparse',
      sourceAsset: 'XLM',
      sourceAmount: 100,
      destinationAsset: 'USDC',
      destinationAmount: 40,
      hops: [{ poolId: 'p1' }, { poolId: 'p2' }],
    });

    expect(normalized.hops[0].fromAmount).toBe(100);
    expect(normalized.hops[0].toAmount).toBe(100);
    expect(normalized.hops[1].fromAmount).toBe(100);
    expect(normalized.hops[1].toAsset).toBe('USDC');
  });

  it('falls back to the pool id when no pool label is supplied', () => {
    const normalized = normalizePathPaymentFlow({
      id: 'flow-nolabel',
      sourceAsset: 'XLM',
      sourceAmount: 10,
      destinationAsset: 'USDC',
      destinationAmount: 2,
      hops: [{ poolId: 'pool-only' }],
    });

    expect(normalized.hops[0].poolLabel).toBe('pool-only');
  });

  it('treats string amounts from JSON payloads as numbers', () => {
    const normalized = normalizePathPaymentFlow({
      id: 'flow-strings',
      sourceAsset: 'XLM',
      sourceAmount: '250' as unknown as number,
      destinationAsset: 'USDC',
      destinationAmount: '50' as unknown as number,
      hops: [
        {
          poolId: 'p1',
          fromAsset: 'XLM',
          fromAmount: '250' as unknown as number,
          toAsset: 'USDC',
          toAmount: '50' as unknown as number,
          feeAmount: '0.25' as unknown as number,
        },
      ],
    });

    expect(normalized.sourceAmount).toBe(250);
    expect(normalized.hops[0].feeAmount).toBe(0.25);
  });

  it('accumulates fees per asset', () => {
    expect(normalizePathPaymentFlow(TWO_HOP).feesByAsset).toEqual({ XLM: 5, USDC: 1.225 });
  });

  it('drops zero-value flows as unrenderable', () => {
    expect(
      isRenderableFlow(
        normalizePathPaymentFlow({
          id: 'flow-zero',
          sourceAsset: 'XLM',
          sourceAmount: 0,
          destinationAsset: 'USDC',
          destinationAmount: 0,
        }),
      ),
    ).toBe(false);
  });
});

describe('calculateFeeBps', () => {
  it('expresses the fee as basis points of the hop input', () => {
    expect(calculateFeeBps(5, 10000)).toBeCloseTo(5);
  });

  it('returns zero instead of dividing by a zero amount', () => {
    expect(calculateFeeBps(5, 0)).toBe(0);
  });
});

describe('summarizePathPaymentFees', () => {
  it('sums fees per asset and omits assets with no fees', () => {
    expect(summarizePathPaymentFees([TWO_HOP, ONE_HOP])).toEqual([
      { asset: 'XLM', amount: 7.5 },
      { asset: 'USDC', amount: 1.225 },
    ]);
  });

  it('returns an empty summary when nothing is charged', () => {
    const summary = summarizePathPaymentFees([
      { id: 'no-fee', sourceAsset: 'XLM', sourceAmount: 1, destinationAsset: 'USDC', destinationAmount: 1 },
    ]);

    expect(summary).toEqual([]);
  });
});

describe('countPathPaymentHops', () => {
  it('counts every hop across all routes', () => {
    expect(countPathPaymentHops([TWO_HOP, ONE_HOP])).toBe(3);
    expect(countPathPaymentHops([])).toBe(0);
  });
});

describe('colorForAsset', () => {
  it('is deterministic and case insensitive', () => {
    expect(colorForAsset('usdc')).toBe(colorForAsset('USDC'));
  });
});

describe('buildSankeyGraph', () => {
  it('lays a single hop route out as source, pool, destination', () => {
    const graph = build([ONE_HOP]);

    expect(graph.columns).toBe(3);
    expect(graph.nodes.map((node) => node.role)).toEqual(['source', 'pool', 'destination']);
    expect(graph.links).toHaveLength(2);
  });

  it('produces one column per conversion step for a two hop route', () => {
    const graph = build([TWO_HOP]);

    expect(graph.columns).toBe(4);
    expect(graph.nodes.map((node) => node.asset)).toEqual(['XLM', 'USDC', 'EURC', 'EURC']);
  });

  it('merges routes that traverse the same pool at the same depth', () => {
    const graph = build([TWO_HOP, ONE_HOP]);
    const sharedPool = graph.nodes.filter(
      (node) => node.role === 'pool' && node.poolId === 'xlm-usdc',
    );

    expect(sharedPool).toHaveLength(1);
    expect(sharedPool[0].flowIds).toEqual(['flow-a', 'flow-b']);
    expect(sharedPool[0].value).toBe(15000);
  });

  it('only ever links a node to the next column', () => {
    const graph = build(SAMPLE_PATH_PAYMENT_FLOWS);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));

    graph.links.forEach((link) => {
      const source = byId.get(link.sourceId);
      const target = byId.get(link.targetId);
      expect(source).toBeDefined();
      expect(target).toBeDefined();
      expect(target!.column).toBe(source!.column + 1);
      expect(source!.x + source!.width).toBeLessThanOrEqual(target!.x);
    });
  });

  it('keeps every ribbon inside the bounds of the nodes it touches', () => {
    const graph = build(SAMPLE_PATH_PAYMENT_FLOWS);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));

    graph.nodes.forEach((node) => {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(graph.width);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y + node.height).toBeLessThanOrEqual(graph.height);
      expect(node.height).toBeGreaterThan(0);
    });

    graph.links.forEach((link) => {
      const source = byId.get(link.sourceId)!;
      const target = byId.get(link.targetId)!;
      expect(link.thickness).toBeGreaterThan(0);
      expect(link.thickness).toBeLessThanOrEqual(Math.max(source.height, target.height));
      expect(link.d.startsWith('M')).toBe(true);
      expect(link.d).not.toContain('NaN');
    });
  });

  it('scales ribbons to the traded amount by default', () => {
    const graph = build([TWO_HOP, ONE_HOP]);
    const firstHop = graph.links.find((link) => link.id === 'flow-a::link-0')!;
    const secondHop = graph.links.find((link) => link.id === 'flow-b::link-0')!;

    expect(firstHop.value).toBe(10000);
    expect(secondHop.value).toBe(5000);
    expect(firstHop.thickness).toBeGreaterThan(secondHop.thickness);
    expect(graph.links.find((link) => link.id === 'flow-a::link-final')!.feeAmount).toBe(0);
  });

  it('attributes every hop fee to the ribbon entering that pool', () => {
    const graph = build([TWO_HOP], 'fee');
    const feesByHop = graph.links
      .filter((link) => link.hopIndex >= 0)
      .map((link) => [link.hopIndex, link.feeAmount]);

    expect(feesByHop).toEqual([
      [0, 5],
      [1, 1.225],
    ]);
  });

  it('scales fee ribbons independently of the traded amount', () => {
    const amountGraph = build([TWO_HOP, ONE_HOP]);
    const feeGraph = build([TWO_HOP, ONE_HOP], 'fee');
    const amountFinal = amountGraph.links.find((link) => link.id === 'flow-a::link-final')!;
    const feeFinal = feeGraph.links.find((link) => link.id === 'flow-a::link-final')!;

    expect(amountFinal.value).toBe(2238.75);
    expect(feeFinal.value).toBe(0);
    expect(feeFinal.thickness).toBeLessThan(amountFinal.thickness);
  });

  it('handles a cycle between two assets without producing backwards links', () => {
    const graph = build([
      {
        id: 'cycle',
        sourceAsset: 'A',
        sourceAmount: 10,
        destinationAsset: 'A',
        destinationAmount: 9,
        hops: [
          { poolId: 'a-b', fromAsset: 'A', fromAmount: 10, toAsset: 'B', toAmount: 9.5, feeAmount: 0.5 },
          { poolId: 'b-a', fromAsset: 'B', fromAmount: 9.5, toAsset: 'A', toAmount: 9, feeAmount: 0.5 },
        ],
      },
    ]);

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    graph.links.forEach((link) => {
      expect(byId.get(link.targetId)!.column).toBe(byId.get(link.sourceId)!.column + 1);
    });
  });

  it('renders a direct transfer as a single source to destination link', () => {
    const graph = build([
      { id: 'direct', sourceAsset: 'XLM', sourceAmount: 10, destinationAsset: 'XLM', destinationAmount: 10 },
    ]);

    expect(graph.links).toHaveLength(1);
    expect(graph.nodes.map((node) => node.role)).toEqual(['source', 'destination']);
  });

  it('returns an empty graph for an empty flow list', () => {
    const graph = build([]);

    expect(graph.nodes).toHaveLength(0);
    expect(graph.links).toHaveLength(0);
    expect(graph.columns).toBe(0);
  });

  it('survives a degenerate container size', () => {
    const graph = buildSankeyGraph([TWO_HOP], { width: 0, height: 0 });

    expect(graph.links.length).toBeGreaterThan(0);
    graph.links.forEach((link) => expect(link.d).not.toContain('NaN'));
  });
});
