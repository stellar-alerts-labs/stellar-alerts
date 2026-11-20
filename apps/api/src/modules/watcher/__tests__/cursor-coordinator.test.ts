import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CursorHandoverCoordinator,
  FencingError,
  CursorRollbackError,
  CursorNotStagedError,
  ACQUIRE_SCRIPT,
  RENEW_SCRIPT,
  STAGE_SCRIPT,
  COMMIT_SCRIPT,
  RELEASE_SCRIPT,
  type CursorRedisLike,
  type PromotionInfo,
} from '../cursor-coordinator';

/**
 * In-memory Redis double with a controllable clock. `eval` dispatches on the
 * exported script constants and mirrors each Lua script's semantics 1:1
 * (every script is atomic in real Redis; here each call is synchronous).
 */
class FakeRedis implements CursorRedisLike {
  now = 1_000_000;
  private strings = new Map<string, { value: string; expiresAt: number | null }>();
  private hashes = new Map<string, Record<string, string>>();
  private counters = new Map<string, number>();
  evalCalls = 0;
  failEval = false;

  private get(key: string): string | null {
    const e = this.strings.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= this.now) {
      this.strings.delete(key);
      return null;
    }
    return e.value;
  }

  private hget(key: string, field: string): string | undefined {
    return this.hashes.get(key)?.[field];
  }

  private hset(key: string, fields: Record<string, string | number>) {
    const h = this.hashes.get(key) ?? {};
    for (const [k, v] of Object.entries(fields)) h[k] = String(v);
    this.hashes.set(key, h);
  }

  async hgetall(key: string) {
    return { ...(this.hashes.get(key) ?? {}) };
  }

  async eval(script: string, _numkeys: number, ...a: (string | number)[]): Promise<unknown> {
    this.evalCalls++;
    if (this.failEval) throw new Error('redis down');
    const num = (v: string | number | undefined) => Number(v ?? 0);

    switch (script) {
      case ACQUIRE_SCRIPT: {
        const [lock, epochKey, state, nodeId, ttl] = a as [string, string, string, string, number];
        if (this.get(lock) !== null) return -1;
        const epoch = (this.counters.get(epochKey) ?? 0) + 1;
        this.counters.set(epochKey, epoch);
        this.strings.set(lock, { value: `${nodeId}:${epoch}`, expiresAt: this.now + num(ttl) });
        this.hset(state, { epoch, owner: nodeId });
        return epoch;
      }
      case RENEW_SCRIPT: {
        const [lock, token, ttl] = a as [string, string, number];
        if (this.get(lock) !== token) return 0;
        this.strings.get(lock)!.expiresAt = this.now + num(ttl);
        return 1;
      }
      case STAGE_SCRIPT: {
        const [lock, state, token, ledger, ttl] = a as [string, string, string, number, number];
        if (this.get(lock) !== token) return -1;
        if (num(ledger) < num(this.hget(state, 'committed'))) return -2;
        this.hset(state, { staged: ledger });
        this.strings.get(lock)!.expiresAt = this.now + num(ttl);
        return 1;
      }
      case COMMIT_SCRIPT: {
        const [lock, state, token, ledger, ttl] = a as [string, string, string, number, number];
        if (this.get(lock) !== token) return -1;
        if (num(ledger) < num(this.hget(state, 'committed'))) return -2;
        if (num(ledger) > num(this.hget(state, 'staged'))) return -3;
        this.hset(state, { committed: ledger });
        this.strings.get(lock)!.expiresAt = this.now + num(ttl);
        return 1;
      }
      case RELEASE_SCRIPT: {
        const [lock, state, token, final, releasedAt] = a as [string, string, string, number, number];
        if (this.get(lock) !== token) return -1;
        if (num(final) >= 0) {
          if (num(final) < num(this.hget(state, 'committed'))) return -2;
          if (num(final) > num(this.hget(state, 'staged'))) return -3;
          this.hset(state, { committed: final });
        }
        this.strings.delete(lock);
        this.hset(state, { owner: '', releasedAt });
        return 1;
      }
      default:
        throw new Error('unknown script');
    }
  }

  advance(ms: number) {
    this.now += ms;
  }
}

function makeNode(redis: FakeRedis, nodeId: string, extra: Partial<ConstructorParameters<typeof CursorHandoverCoordinator>[0]> = {}) {
  return new CursorHandoverCoordinator({
    redis,
    nodeId,
    leaseTtlMs: 10_000,
    heartbeatIntervalMs: 3_000,
    minShadowObservations: 1,
    now: () => redis.now,
    ...extra,
  });
}

/** Starts a node and ticks until it is primary (or gives up). */
async function startAndTick(node: CursorHandoverCoordinator, ticks = 3) {
  await node.start({ autoTick: false });
  for (let i = 0; i < ticks && !node.isPrimary; i++) await node.tick();
}

describe('CursorHandoverCoordinator', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('boots as shadow, then becomes primary when the lease is free', async () => {
    const promoted = vi.fn();
    const node = makeNode(redis, 'A', { onPromoted: promoted });
    await startAndTick(node);

    expect(node.isPrimary).toBe(true);
    expect(node.epoch).toBe(1);
    expect(promoted).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'A', epoch: 1, resumeFrom: 0, replayWindow: null }));
  });

  it('a second node stays in shadow while the primary holds the lease', async () => {
    const a = makeNode(redis, 'A');
    const b = makeNode(redis, 'B');
    await startAndTick(a);
    await startAndTick(b, 5);

    expect(a.isPrimary).toBe(true);
    expect(b.role).toBe('shadow');
  });

  it('only one of two simultaneously booting nodes wins the race', async () => {
    const a = makeNode(redis, 'A');
    const b = makeNode(redis, 'B');
    await Promise.all([a.start({ autoTick: false }), b.start({ autoTick: false })]);
    await Promise.all([a.tick(), b.tick()]);
    expect([a.isPrimary, b.isPrimary].filter(Boolean)).toHaveLength(1);
  });

  it('shadow does not contend until its warm-up reports ready', async () => {
    let ready = false;
    const node = makeNode(redis, 'B', { warmup: () => ready });
    await startAndTick(node, 4);
    expect(node.role).toBe('shadow');

    ready = true;
    await node.tick();
    expect(node.isPrimary).toBe(true);
  });

  it('treats a throwing warm-up as not ready', async () => {
    const node = makeNode(redis, 'B', {
      warmup: () => {
        throw new Error('db down');
      },
    });
    await startAndTick(node, 3);
    expect(node.role).toBe('shadow');
  });

  it('requires the configured number of shadow observations before promoting', async () => {
    const seen = vi.fn();
    const node = makeNode(redis, 'B', { minShadowObservations: 3, onShadowObserved: seen });
    await node.start({ autoTick: false }); // observation 1
    await node.tick(); // 2
    expect(node.role).toBe('shadow');
    await node.tick(); // 3 -> promote
    expect(node.isPrimary).toBe(true);
    expect(seen).toHaveBeenCalledTimes(3);
  });

  describe('two-phase cursor commit', () => {
    it('stage then commit advances the committed cursor', async () => {
      const a = makeNode(redis, 'A');
      await startAndTick(a);
      await a.stage(100);
      expect((await a.readState()).staged).toBe(100);
      expect((await a.readState()).committed).toBe(0);
      await a.commit(100);
      expect(await a.readState()).toMatchObject({ committed: 100, staged: 100 });
    });

    it('refuses to commit a ledger that was never staged', async () => {
      const a = makeNode(redis, 'A');
      await startAndTick(a);
      await a.stage(100);
      await expect(a.commit(101)).rejects.toBeInstanceOf(CursorNotStagedError);
    });

    it('never lets the cursor roll back', async () => {
      const a = makeNode(redis, 'A');
      await startAndTick(a);
      await a.stage(200);
      await a.commit(200);
      await expect(a.stage(150)).rejects.toBeInstanceOf(CursorRollbackError);
      await expect(a.commit(150)).rejects.toBeInstanceOf(CursorRollbackError);
      expect((await a.readState()).committed).toBe(200);
    });

    it('rejects stage/commit from a node that is not primary', async () => {
      const b = makeNode(redis, 'B', { minShadowObservations: 5 });
      await b.start({ autoTick: false });
      await expect(b.stage(1)).rejects.toBeInstanceOf(FencingError);
      await expect(b.commit(1)).rejects.toBeInstanceOf(FencingError);
    });
  });

  describe('graceful rolling deploy', () => {
    it('hands over with zero gap and zero replay', async () => {
      const old = makeNode(redis, 'old');
      await startAndTick(old);
      await old.stage(500);
      await old.commit(500);
      await old.stage(520); // batch in flight...
      await old.commit(520); // ...and finished before shutdown

      // New version boots while the old one is still primary.
      const promoted: PromotionInfo[] = [];
      const fresh = makeNode(redis, 'new', { onPromoted: (i) => void promoted.push(i) });
      await startAndTick(fresh, 3);
      expect(fresh.role).toBe('shadow'); // shadowing; no overlap, no duplicate ingestion
      expect(fresh.committedCursor).toBe(520);

      const result = await old.handOver();
      expect(result).toEqual({ released: true, committed: 520 });
      expect(old.role).toBe('stopped');

      await fresh.tick();
      expect(fresh.isPrimary).toBe(true);
      expect(promoted).toHaveLength(1);
      // Resumes exactly at the last committed ledger: nothing skipped, nothing replayed.
      expect(promoted[0]).toMatchObject({ resumeFrom: 520, replayWindow: null, epoch: 2 });
    });

    it('supports a final commit during handover', async () => {
      const old = makeNode(redis, 'old');
      await startAndTick(old);
      await old.stage(300);
      await old.commit(300);

      const result = await old.handOver(310);
      expect(result).toEqual({ released: true, committed: 310 });

      const fresh = makeNode(redis, 'new');
      await startAndTick(fresh);
      expect(fresh.isPrimary).toBe(true);
      expect((await fresh.readState()).committed).toBe(310);
    });

    it('still releases the lease when the final commit is rejected', async () => {
      const old = makeNode(redis, 'old');
      await startAndTick(old);
      await old.stage(300);
      await old.commit(300);

      // 250 < committed: the final stage is a rollback; handover must degrade, not strand the lease.
      const result = await old.handOver(250);
      expect(result.released).toBe(true);
      expect(result.committed).toBe(300);

      const fresh = makeNode(redis, 'new');
      await startAndTick(fresh);
      expect(fresh.isPrimary).toBe(true);
    });

    it('an unstarted/shadow node handing over just stops', async () => {
      const node = makeNode(redis, 'B', { minShadowObservations: 5 });
      await node.start({ autoTick: false });
      expect(await node.handOver()).toEqual({ released: false, committed: 0 });
      expect(node.role).toBe('stopped');
    });
  });

  describe('crash recovery', () => {
    it('new primary takes over after lease expiry and is told the replay window', async () => {
      const dead = makeNode(redis, 'dead');
      await startAndTick(dead);
      await dead.stage(400);
      await dead.commit(400);
      await dead.stage(450); // crashed mid-batch: staged but never committed
      dead.stop(); // no release: simulates kill -9

      const promoted: PromotionInfo[] = [];
      const fresh = makeNode(redis, 'fresh', { onPromoted: (i) => void promoted.push(i) });
      await startAndTick(fresh, 3);
      expect(fresh.role).toBe('shadow'); // lease still valid

      redis.advance(10_001); // TTL elapses
      await fresh.tick();
      expect(fresh.isPrimary).toBe(true);
      expect(promoted[0]).toMatchObject({
        resumeFrom: 400, // never ahead of fully processed work -> no gap
        replayWindow: { from: 400, to: 450 }, // possibly partial -> replay under dedup
      });
    });
  });

  describe('fencing & lease heartbeat', () => {
    it('a zombie primary cannot write after takeover', async () => {
      const zombie = makeNode(redis, 'zombie');
      await startAndTick(zombie);
      await zombie.stage(10);
      await zombie.commit(10);

      // Zombie stalls (GC pause / partition) past its lease; a new node takes over.
      redis.advance(10_001);
      const next = makeNode(redis, 'next');
      await startAndTick(next);
      expect(next.isPrimary).toBe(true);
      await next.stage(20);
      await next.commit(20);

      // Zombie wakes up and tries to write with its stale token.
      await expect(zombie.stage(15)).rejects.toBeInstanceOf(FencingError);
      await expect(zombie.commit(10)).rejects.toBeInstanceOf(FencingError);
      expect((await next.readState()).committed).toBe(20);
    });

    it('renews the lease on heartbeat so a healthy primary keeps it past the original TTL', async () => {
      const a = makeNode(redis, 'A');
      const b = makeNode(redis, 'B');
      await startAndTick(a);
      await startAndTick(b, 2);

      for (let i = 0; i < 6; i++) {
        redis.advance(4_000); // > heartbeat (3s), < ttl (10s)
        await a.tick();
        await b.tick();
      }
      expect(a.isPrimary).toBe(true);
      expect(b.role).toBe('shadow');
    });

    it('demotes to shadow and notifies when the lease is lost', async () => {
      const demoted = vi.fn();
      const a = makeNode(redis, 'A', { onDemoted: demoted });
      await startAndTick(a);

      redis.advance(10_001); // lease expired without renewal
      const b = makeNode(redis, 'B');
      await startAndTick(b);
      expect(b.isPrimary).toBe(true);

      redis.advance(4_000);
      await a.tick();
      expect(a.role).toBe('shadow');
      expect(demoted).toHaveBeenCalledWith('lease-lost');
    });

    it('survives a transient Redis error without demoting while the lease is still valid', async () => {
      const a = makeNode(redis, 'A');
      await startAndTick(a);

      redis.advance(4_000);
      redis.failEval = true;
      await a.tick();
      expect(a.isPrimary).toBe(true);

      redis.failEval = false;
      redis.advance(4_000);
      await a.tick();
      expect(a.isPrimary).toBe(true);
    });

    it('demotes once Redis has been unreachable for a full lease TTL', async () => {
      const demoted = vi.fn();
      const a = makeNode(redis, 'A', { onDemoted: demoted });
      await startAndTick(a);

      redis.failEval = true;
      redis.advance(10_001);
      await a.tick();
      // Errored renewals past the TTL mean the lease is gone: demote rather than keep ingesting.
      expect(a.role).toBe('shadow');
      expect(demoted).toHaveBeenCalledWith('lease-lost');
    });
  });

  it('epochs strictly increase across successive primaries', async () => {
    const epochs: number[] = [];
    for (const id of ['n1', 'n2', 'n3']) {
      const node = makeNode(redis, id);
      await startAndTick(node);
      epochs.push(node.epoch);
      await node.handOver();
    }
    expect(epochs).toEqual([1, 2, 3]);
  });
});
