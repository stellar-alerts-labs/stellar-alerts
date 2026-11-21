/**
 * Consistent hash ring for partitioning monitored wallets across a fleet of watcher workers (#984).
 *
 * Modulo sharding (`hash % N`) moves about (N-1)/N of the keys whenever a worker joins or leaves.
 * On a ring with virtual nodes only the keys that belong to the node that changed move: roughly
 * 1/N of them.
 *
 * The ring is pure and deterministic. `ConsistentHashCoordinator` keeps it in step with worker
 * heartbeats read from an injected store (Redis in production), so a worker that stops
 * heartbeating is dropped from the ring and its keys are redistributed.
 */

/** Virtual nodes per physical worker. */
export const DEFAULT_VIRTUAL_NODES = 150;
/** A worker whose last heartbeat is older than this is considered dead. */
export const DEFAULT_HEARTBEAT_TTL_MS = 5_000;

/** 32-bit MurmurHash3 (x86 variant) of a UTF-8 string. */
export function murmur3(input: string, seed = 0): number {
  const data = new TextEncoder().encode(input);
  const length = data.length;
  const blocks = length >> 2;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;

  for (let i = 0; i < blocks; i += 1) {
    const o = i << 2;
    let k = (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  let k = 0;
  const tail = blocks << 2;
  switch (length & 3) {
    case 3:
      k ^= data[tail + 2] << 16;
    // falls through
    case 2:
      k ^= data[tail + 1] << 8;
    // falls through
    case 1:
      k ^= data[tail];
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }

  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

interface VirtualNode {
  hash: number;
  nodeId: string;
}

/** A 32-bit hash ring with virtual nodes. */
export class ConsistentHashRing {
  private ring: VirtualNode[] = [];
  private readonly nodes = new Set<string>();

  constructor(private readonly virtualNodes = DEFAULT_VIRTUAL_NODES) {
    if (!Number.isInteger(virtualNodes) || virtualNodes < 1) {
      throw new Error('virtualNodes must be a positive integer');
    }
  }

  get size(): number {
    return this.nodes.size;
  }

  getNodes(): string[] {
    return [...this.nodes].sort();
  }

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  addNode(nodeId: string): boolean {
    if (this.nodes.has(nodeId)) return false;
    this.nodes.add(nodeId);
    for (let i = 0; i < this.virtualNodes; i += 1) {
      this.ring.push({ hash: murmur3(`${nodeId}#${i}`), nodeId });
    }
    this.ring.sort((a, b) => a.hash - b.hash || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
    return true;
  }

  removeNode(nodeId: string): boolean {
    if (!this.nodes.delete(nodeId)) return false;
    this.ring = this.ring.filter((virtualNode) => virtualNode.nodeId !== nodeId);
    return true;
  }

  /** The worker that owns `key`, or `null` when the ring is empty. */
  getNode(key: string): string | null {
    if (this.ring.length === 0) return null;
    const hash = murmur3(key);

    // First virtual node at or after the hash, wrapping around the ring.
    let low = 0;
    let high = this.ring.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.ring[mid].hash < hash) low = mid + 1;
      else high = mid;
    }
    return this.ring[low === this.ring.length ? 0 : low].nodeId;
  }
}

/** One worker's last heartbeat. */
export interface WorkerHeartbeat {
  nodeId: string;
  /** Epoch milliseconds of the last heartbeat. */
  lastSeenMs: number;
}

export interface HeartbeatStore {
  /** Records a heartbeat for a worker. */
  heartbeat(nodeId: string, nowMs: number): Promise<void>;
  /** Every worker that has ever sent one, with its latest heartbeat. */
  list(): Promise<WorkerHeartbeat[]>;
  /** Forgets a worker that has been declared dead. */
  remove(nodeId: string): Promise<void>;
}

export interface MembershipChange {
  added: string[];
  removed: string[];
}

export interface CoordinatorOptions {
  virtualNodes?: number;
  heartbeatTtlMs?: number;
  now?: () => number;
}

export class ConsistentHashCoordinator {
  private readonly ring: ConsistentHashRing;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(
    private readonly store: HeartbeatStore,
    options: CoordinatorOptions = {},
  ) {
    this.ring = new ConsistentHashRing(options.virtualNodes ?? DEFAULT_VIRTUAL_NODES);
    this.ttl = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Called by each worker on an interval shorter than the TTL. */
  async heartbeat(nodeId: string): Promise<void> {
    await this.store.heartbeat(nodeId, this.now());
  }

  /**
   * Brings the ring in line with the heartbeats: workers seen within the TTL join, workers that
   * have gone quiet leave and are forgotten. Returns what changed.
   */
  async sync(): Promise<MembershipChange> {
    const nowMs = this.now();
    const beats = await this.store.list();
    const change: MembershipChange = { added: [], removed: [] };

    const alive = new Set<string>();
    for (const beat of beats) {
      if (nowMs - beat.lastSeenMs <= this.ttl) alive.add(beat.nodeId);
      else {
        await this.store.remove(beat.nodeId);
      }
    }

    for (const nodeId of this.ring.getNodes()) {
      if (!alive.has(nodeId)) {
        this.ring.removeNode(nodeId);
        change.removed.push(nodeId);
      }
    }
    for (const nodeId of [...alive].sort()) {
      if (this.ring.addNode(nodeId)) change.added.push(nodeId);
    }
    return change;
  }

  /** The worker that should watch `address`, or `null` when no worker is alive. */
  assign(address: string): string | null {
    return this.ring.getNode(address);
  }

  /** Whether `nodeId` is the owner of `address`. */
  owns(nodeId: string, address: string): boolean {
    return this.ring.getNode(address) === nodeId;
  }

  /** The keys, out of `addresses`, that belong to `nodeId`. */
  shardFor(nodeId: string, addresses: readonly string[]): string[] {
    return addresses.filter((address) => this.owns(nodeId, address));
  }

  getMembers(): string[] {
    return this.ring.getNodes();
  }
}

/** An in-memory heartbeat store, for tests and single-process use. */
export class InMemoryHeartbeatStore implements HeartbeatStore {
  private readonly beats = new Map<string, number>();

  async heartbeat(nodeId: string, nowMs: number): Promise<void> {
    this.beats.set(nodeId, nowMs);
  }

  async list(): Promise<WorkerHeartbeat[]> {
    return [...this.beats].map(([nodeId, lastSeenMs]) => ({ nodeId, lastSeenMs }));
  }

  async remove(nodeId: string): Promise<void> {
    this.beats.delete(nodeId);
  }
}

/** The key movement between two assignments of the same keys. */
export function countMoved(keys: readonly string[], before: ConsistentHashRing, after: ConsistentHashRing): number {
  return keys.filter((key) => before.getNode(key) !== after.getNode(key)).length;
}
