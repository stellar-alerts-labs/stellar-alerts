import { describe, expect, it } from 'vitest';
import {
  ConsistentHashCoordinator,
  ConsistentHashRing,
  countMoved,
  DEFAULT_HEARTBEAT_TTL_MS,
  DEFAULT_VIRTUAL_NODES,
  InMemoryHeartbeatStore,
  murmur3,
} from '../consistent-hash';

/** Deterministic stand-ins for 56-character Stellar addresses. */
function addresses(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `G${murmur3(`seed-${i}`).toString(16).padStart(8, '0')}${'A'.repeat(47)}${i}`);
}

function ringOf(nodes: string[], virtualNodes?: number): ConsistentHashRing {
  const ring = new ConsistentHashRing(virtualNodes);
  nodes.forEach((node) => ring.addNode(node));
  return ring;
}

function distribution(keys: string[], ring: ConsistentHashRing): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const node = ring.getNode(key) as string;
    counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  return counts;
}

describe('murmur3', () => {
  // Reference vectors for MurmurHash3_x86_32.
  it.each([
    ['', 0, 0x00000000],
    ['', 1, 0x514e28b7],
    ['', 0xffffffff, 0x81f16f39],
    ['test', 0, 0xba6bd213],
    ['Hello, world!', 0, 0xc0363e43],
    ['a', 0x9747b28c, 0x7fa09ea6],
    ['aa', 0x9747b28c, 0x5d211726],
    ['aaa', 0x9747b28c, 0x283e0130],
    ['aaaa', 0x9747b28c, 0x5a97808a],
    ['abc', 0x9747b28c, 0xc84a62dd],
    ['abcd', 0x9747b28c, 0xf0478627],
    ['Hello, world!', 0x9747b28c, 0x24884cba],
    ['The quick brown fox jumps over the lazy dog', 0x9747b28c, 0x2fa826cd],
  ])('hashes %j with seed %s to the reference value', (input, seed, expected) => {
    expect(murmur3(input, seed)).toBe(expected);
  });

  it('always returns an unsigned 32-bit integer', () => {
    for (const key of addresses(200)) {
      const hash = murmur3(key);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('hashes non-ASCII text by its UTF-8 bytes', () => {
    expect(murmur3('é')).not.toBe(murmur3('e'));
    expect(murmur3('é')).toBe(murmur3('é'));
  });
});

describe('ConsistentHashRing', () => {
  it('uses 150 virtual nodes per worker by default', () => {
    expect(DEFAULT_VIRTUAL_NODES).toBe(150);
  });

  it('returns null when the ring is empty', () => {
    expect(new ConsistentHashRing().getNode('GANY')).toBeNull();
  });

  it('maps every key to the only worker when there is one', () => {
    const ring = ringOf(['w1']);
    for (const key of addresses(50)) expect(ring.getNode(key)).toBe('w1');
  });

  it('maps an address deterministically, however the ring was built', () => {
    const forward = ringOf(['w1', 'w2', 'w3', 'w4']);
    const backward = ringOf(['w4', 'w3', 'w2', 'w1']);

    for (const key of addresses(500)) {
      expect(forward.getNode(key)).toBe(backward.getNode(key));
      expect(forward.getNode(key)).toBe(forward.getNode(key));
    }
  });

  it('wraps around: a key hashing past the last virtual node belongs to the first one', () => {
    // One virtual node per worker makes the ring small enough to place a key on purpose.
    const ring = ringOf(['w1', 'w2'], 1);
    const points = ['w1', 'w2'].map((nodeId) => ({ nodeId, hash: murmur3(`${nodeId}#0`) })).sort((a, b) => a.hash - b.hash);
    let pastLast: string | undefined;
    let beforeFirst: string | undefined;
    for (let i = 0; i < 200_000 && (!pastLast || !beforeFirst); i += 1) {
      const key = `probe-${i}`;
      const hash = murmur3(key);
      if (hash > points[1].hash) pastLast ??= key;
      if (hash <= points[0].hash) beforeFirst ??= key;
    }

    expect(pastLast).toBeDefined();
    expect(ring.getNode(pastLast as string)).toBe(points[0].nodeId);
    expect(beforeFirst).toBeDefined();
    expect(ring.getNode(beforeFirst as string)).toBe(points[0].nodeId);
  });

  it('ignores adding a worker twice and removing one that is not there', () => {
    const ring = ringOf(['w1']);
    expect(ring.addNode('w1')).toBe(false);
    expect(ring.removeNode('nope')).toBe(false);
    expect(ring.size).toBe(1);
  });

  it('rejects an invalid virtual node count', () => {
    expect(() => new ConsistentHashRing(0)).toThrow();
    expect(() => new ConsistentHashRing(1.5)).toThrow();
  });

  it('spreads 20,000 addresses evenly over 5 workers', () => {
    const keys = addresses(20_000);
    const counts = distribution(keys, ringOf(['w1', 'w2', 'w3', 'w4', 'w5']));
    const mean = keys.length / 5;

    expect(counts.size).toBe(5);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(mean * 0.75);
      expect(count).toBeLessThan(mean * 1.25);
    }
  });

  it('spreads more evenly with more virtual nodes', () => {
    const keys = addresses(20_000);
    const spread = (virtualNodes: number) => {
      const counts = [...distribution(keys, ringOf(['w1', 'w2', 'w3', 'w4', 'w5'], virtualNodes)).values()];
      return Math.max(...counts) - Math.min(...counts);
    };
    expect(spread(150)).toBeLessThan(spread(1));
  });

  it('moves about 1/(N+1) of the keys when a worker joins, and only onto the new worker', () => {
    const keys = addresses(20_000);
    const before = ringOf(['w1', 'w2', 'w3', 'w4', 'w5']);
    const after = ringOf(['w1', 'w2', 'w3', 'w4', 'w5', 'w6']);

    const moved = countMoved(keys, before, after);

    expect(moved / keys.length).toBeLessThan(1 / 6 + 0.05);
    expect(moved / keys.length).toBeGreaterThan(1 / 6 - 0.05);
    for (const key of keys) {
      if (before.getNode(key) !== after.getNode(key)) expect(after.getNode(key)).toBe('w6');
    }
  });

  it('moves only the leaving worker\'s keys, about 1/N, when a worker leaves', () => {
    const keys = addresses(20_000);
    const before = ringOf(['w1', 'w2', 'w3', 'w4', 'w5']);
    const after = ringOf(['w1', 'w2', 'w3', 'w4', 'w5']);
    after.removeNode('w3');

    const moved = countMoved(keys, before, after);

    expect(moved / keys.length).toBeLessThan(1 / 5 + 0.05);
    for (const key of keys) {
      if (before.getNode(key) !== after.getNode(key)) expect(before.getNode(key)).toBe('w3');
      else expect(after.getNode(key)).not.toBe('w3');
    }
  });

  it('puts every key back where it was when a worker leaves and comes back', () => {
    const keys = addresses(2_000);
    const ring = ringOf(['w1', 'w2', 'w3']);
    const original = keys.map((key) => ring.getNode(key));

    ring.removeNode('w2');
    ring.addNode('w2');

    expect(keys.map((key) => ring.getNode(key))).toEqual(original);
  });

  it('moves far more with modulo sharding, which is the problem this solves', () => {
    const keys = addresses(20_000);
    const workers = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const grown = [...workers, 'w6'];
    const moduloMoved = keys.filter((key) => workers[murmur3(key) % 5] !== grown[murmur3(key) % 6]).length;
    const ringMoved = countMoved(keys, ringOf(workers), ringOf(grown));

    expect(moduloMoved / keys.length).toBeGreaterThan(0.7);
    expect(ringMoved).toBeLessThan(moduloMoved / 3);
  });

  it('keeps every key owned when workers are removed down to one', () => {
    const ring = ringOf(['w1', 'w2', 'w3']);
    ring.removeNode('w1');
    ring.removeNode('w3');
    for (const key of addresses(100)) expect(ring.getNode(key)).toBe('w2');
  });
});

describe('ConsistentHashCoordinator', () => {
  function setup() {
    let now = 1_000_000;
    const store = new InMemoryHeartbeatStore();
    const coordinator = new ConsistentHashCoordinator(store, { now: () => now });
    return {
      store,
      coordinator,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('declares a 5 second heartbeat TTL by default', () => {
    expect(DEFAULT_HEARTBEAT_TTL_MS).toBe(5_000);
  });

  it('admits workers that heartbeat and assigns addresses to them', async () => {
    const { coordinator } = setup();
    await coordinator.heartbeat('w1');
    await coordinator.heartbeat('w2');

    const change = await coordinator.sync();

    expect(change).toEqual({ added: ['w1', 'w2'], removed: [] });
    expect(coordinator.getMembers()).toEqual(['w1', 'w2']);
    expect(['w1', 'w2']).toContain(coordinator.assign('GSOMEADDRESS'));
  });

  it('assigns nothing while no worker is alive', async () => {
    const { coordinator } = setup();
    await coordinator.sync();
    expect(coordinator.assign('GSOMEADDRESS')).toBeNull();
  });

  it('keeps a worker whose last heartbeat is exactly 5 seconds old, and drops it just after', async () => {
    const { coordinator, advance } = setup();
    await coordinator.heartbeat('w1');
    await coordinator.sync();

    advance(5_000);
    expect((await coordinator.sync()).removed).toEqual([]);

    advance(1);
    expect((await coordinator.sync()).removed).toEqual(['w1']);
  });

  it('redistributes a dead worker\'s addresses to the survivors, and only those', async () => {
    const { coordinator, advance } = setup();
    for (const id of ['w1', 'w2', 'w3']) await coordinator.heartbeat(id);
    await coordinator.sync();
    const keys = addresses(3_000);
    const before = new Map(keys.map((key) => [key, coordinator.assign(key)]));

    advance(3_000);
    await coordinator.heartbeat('w1');
    await coordinator.heartbeat('w3'); // w2 goes quiet
    advance(2_500);
    const change = await coordinator.sync();

    expect(change.removed).toEqual(['w2']);
    for (const key of keys) {
      const after = coordinator.assign(key);
      expect(after).not.toBe('w2');
      if (before.get(key) !== 'w2') expect(after).toBe(before.get(key));
    }
  });

  it('keeps a worker that keeps heartbeating', async () => {
    const { coordinator, advance } = setup();
    for (let i = 0; i < 10; i += 1) {
      await coordinator.heartbeat('w1');
      await coordinator.sync();
      advance(2_000);
    }
    expect(coordinator.getMembers()).toEqual(['w1']);
  });

  it('readmits a worker that comes back and gives it the same shard as before', async () => {
    const { coordinator, advance } = setup();
    for (const id of ['w1', 'w2']) await coordinator.heartbeat(id);
    await coordinator.sync();
    const keys = addresses(1_000);
    const before = keys.map((key) => coordinator.assign(key));

    advance(10_000);
    await coordinator.heartbeat('w1');
    await coordinator.sync(); // w2 dropped
    await coordinator.heartbeat('w2');
    const change = await coordinator.sync();

    expect(change.added).toEqual(['w2']);
    expect(keys.map((key) => coordinator.assign(key))).toEqual(before);
  });

  it('forgets a dead worker\'s heartbeat so it is not rechecked forever', async () => {
    const { coordinator, store, advance } = setup();
    await coordinator.heartbeat('w1');
    advance(6_000);

    await coordinator.sync();

    expect(await store.list()).toEqual([]);
  });

  it('gives each worker exactly its own shard, and the shards partition the addresses', async () => {
    const { coordinator } = setup();
    for (const id of ['w1', 'w2', 'w3']) await coordinator.heartbeat(id);
    await coordinator.sync();
    const keys = addresses(1_000);

    const shards = ['w1', 'w2', 'w3'].map((id) => coordinator.shardFor(id, keys));

    expect(shards.flat().sort()).toEqual([...keys].sort());
    expect(new Set(shards.flat()).size).toBe(keys.length);
    for (const key of keys) {
      expect(coordinator.owns(coordinator.assign(key) as string, key)).toBe(true);
    }
  });
});
