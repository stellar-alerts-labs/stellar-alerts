export type GraphNodeKind = 'wallet' | 'account' | 'pool';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned while the user drags it. */
  fixed: boolean;
  degree: number;
  volume: number;
  cluster: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  asset: string;
  count: number;
  volume: number;
  lastSeen: number;
}

export interface GraphPayment {
  txHash: string;
  from: string;
  to: string;
  amount: number;
  asset: string;
  at?: number;
}

export interface ForceOptions {
  repulsion: number;
  springLength: number;
  springStrength: number;
  gravity: number;
  damping: number;
}

export const DEFAULT_FORCE_OPTIONS: ForceOptions = {
  repulsion: 2400,
  springLength: 90,
  springStrength: 0.02,
  gravity: 0.012,
  damping: 0.82,
};

/** Soroban contract addresses start with C and classic liquidity pools with L; both render as pool nodes. */
export function classifyAddress(address: string, walletAddresses: Set<string>): GraphNodeKind {
  if (walletAddresses.has(address)) return 'wallet';
  if (address.startsWith('C') || address.startsWith('L')) return 'pool';
  return 'account';
}

/**
 * Incrementally-built payment graph with an O(n^2) force simulation. Node count
 * is capped so the canvas stays smooth in real time; the least recently active
 * non-wallet nodes are evicted first.
 */
export class TransactionGraph {
  nodes = new Map<string, GraphNode>();
  edges = new Map<string, GraphEdge>();
  private seenTx = new Set<string>();
  private walletAddresses = new Set<string>();
  private lastActivity = new Map<string, number>();

  constructor(private readonly maxNodes = 400) {}

  setWalletAddresses(addresses: Iterable<string>): void {
    this.walletAddresses = new Set(addresses);
    for (const node of this.nodes.values()) {
      node.kind = classifyAddress(node.id, this.walletAddresses);
    }
  }

  private ensureNode(id: string, near?: GraphNode): GraphNode {
    let node = this.nodes.get(id);
    if (!node) {
      const angle = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 30;
      node = {
        id,
        kind: classifyAddress(id, this.walletAddresses),
        x: (near?.x ?? 0) + Math.cos(angle) * r,
        y: (near?.y ?? 0) + Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        fixed: false,
        degree: 0,
        volume: 0,
        cluster: 0,
      };
      this.nodes.set(id, node);
    }
    return node;
  }

  /** Adds a payment hop. Returns false when it was already ingested (dedupes replays and reconnects). */
  addPayment(payment: GraphPayment): boolean {
    const key = `${payment.txHash}:${payment.from}:${payment.to}:${payment.asset}`;
    if (this.seenTx.has(key) || !payment.from || !payment.to || payment.from === payment.to) return false;
    this.seenTx.add(key);

    const at = payment.at ?? Date.now();
    const target = this.ensureNode(payment.to);
    const source = this.ensureNode(payment.from, target);
    source.volume += payment.amount;
    target.volume += payment.amount;
    this.lastActivity.set(source.id, at);
    this.lastActivity.set(target.id, at);

    const edgeId = `${payment.from}->${payment.to}:${payment.asset}`;
    const edge = this.edges.get(edgeId);
    if (edge) {
      edge.count += 1;
      edge.volume += payment.amount;
      edge.lastSeen = at;
    } else {
      this.edges.set(edgeId, {
        id: edgeId,
        source: payment.from,
        target: payment.to,
        asset: payment.asset,
        count: 1,
        volume: payment.amount,
        lastSeen: at,
      });
      source.degree += 1;
      target.degree += 1;
    }

    this.evict();
    this.assignClusters();
    return true;
  }

  private evict(): void {
    if (this.nodes.size <= this.maxNodes) return;
    const ordered = [...this.nodes.keys()]
      .filter((id) => !this.walletAddresses.has(id))
      .sort((a, b) => (this.lastActivity.get(a) ?? 0) - (this.lastActivity.get(b) ?? 0));
    let excess = this.nodes.size - this.maxNodes;
    for (const id of ordered) {
      if (excess-- <= 0) break;
      this.nodes.delete(id);
      this.lastActivity.delete(id);
      for (const [edgeId, edge] of this.edges) {
        if (edge.source === id || edge.target === id) {
          this.edges.delete(edgeId);
          const other = this.nodes.get(edge.source === id ? edge.target : edge.source);
          if (other) other.degree = Math.max(0, other.degree - 1);
        }
      }
    }
  }

  /** Connected components (union-find) are treated as address clusters. */
  assignClusters(): number {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    for (const id of this.nodes.keys()) parent.set(id, id);
    for (const e of this.edges.values()) {
      if (this.nodes.has(e.source) && this.nodes.has(e.target)) {
        parent.set(find(e.source), find(e.target));
      }
    }
    const ids = new Map<string, number>();
    for (const node of this.nodes.values()) {
      const root = find(node.id);
      if (!ids.has(root)) ids.set(root, ids.size);
      node.cluster = ids.get(root)!;
    }
    return ids.size;
  }

  clusterCount(): number {
    return new Set([...this.nodes.values()].map((n) => n.cluster)).size;
  }

  /** Advances the simulation one tick. Returns total kinetic energy so callers can idle once settled. */
  step(options: ForceOptions = DEFAULT_FORCE_OPTIONS): number {
    const nodes = [...this.nodes.values()];

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          dist2 = dx * dx + dy * dy + 0.01;
        }
        if (dist2 > 160000) continue;
        const dist = Math.sqrt(dist2);
        const force = options.repulsion / dist2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (const e of this.edges.values()) {
      const s = this.nodes.get(e.source);
      const t = this.nodes.get(e.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - options.springLength) * options.springStrength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      s.vx += fx;
      s.vy += fy;
      t.vx -= fx;
      t.vy -= fy;
    }

    let energy = 0;
    for (const n of nodes) {
      n.vx -= n.x * options.gravity;
      n.vy -= n.y * options.gravity;
      if (n.fixed) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= options.damping;
      n.vy *= options.damping;
      n.x += n.vx;
      n.y += n.vy;
      energy += n.vx * n.vx + n.vy * n.vy;
    }
    return energy;
  }
}

const CLUSTER_PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#fb923c', '#22d3ee', '#a3e635'];

export function clusterColor(cluster: number): string {
  return CLUSTER_PALETTE[cluster % CLUSTER_PALETTE.length];
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}...${address.slice(-4)}` : address;
}
