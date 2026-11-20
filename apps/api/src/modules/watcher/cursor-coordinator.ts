/**
 * CursorHandoverCoordinator — zero-downtime ingestion handover between
 * watcher nodes using a Redis lease plus a two-phase (stage → commit) cursor.
 *
 * Problem: during a rolling deploy two watcher processes briefly coexist.
 * Naively either (a) the old node stops and the new one starts from a cursor
 * that has already advanced → missed ledgers, or (b) the new one starts from
 * an older cursor while the old one is still alive → duplicate alert storms.
 *
 * Protocol
 * ────────
 *  1. SHADOW. A booting node never takes ingestion directly. It observes the
 *     committed cursor, finishes its own warm-up (DB reachable, registries
 *     loaded) and only *then* is allowed to contend for the primary lease.
 *  2. PRIMARY LEASE with fencing. The lease value is `<nodeId>:<epoch>` where
 *     epoch is a Redis INCR counter, so every acquisition has a unique,
 *     monotonically increasing fencing token. Every cursor mutation is a Lua
 *     script that re-checks the token atomically; a paused/zombie ex-primary
 *     can never write after takeover.
 *  3. STAGE → COMMIT. Before a batch the primary STAGEs the highest ledger it
 *     intends to cover ("this window may be in flight"); only after the batch's
 *     side effects are durable does it COMMIT. The committed cursor is
 *     monotonic (never rolls back) and cannot exceed the staged cursor.
 *  4. GRACEFUL HANDOVER. On shutdown the primary stops work, optionally makes a
 *     final commit and releases the lease in one atomic script. A shadow sees
 *     the free lease on its next poll and resumes exactly at the committed
 *     cursor: nothing is skipped (cursor only advances after processing) and
 *     nothing is replayed (everything up to the cursor is already done).
 *  5. CRASH. If the primary dies, the lease expires after `leaseTtlMs`. The new
 *     primary resumes from the committed cursor and is told the replay window
 *     (committed, staged] that may have been partially processed, so it can run
 *     that window under strict deduplication instead of alerting twice.
 *
 * Guarantees: at most one node believes it is primary at a time (modulo clock
 * drift bounded by the lease TTL and fenced by tokens); the resume point is
 * never ahead of fully processed work (no gap); the cursor never moves
 * backwards (no replay storm from a rollback).
 */
import { randomUUID } from 'crypto';
import { createLogger } from '../../lib/logger';

const log = createLogger({ module: 'CursorHandoverCoordinator' });

// ── Lua scripts (exported so the test double can mirror their semantics) ─────

/** KEYS: lock, epochCounter, state | ARGV: nodeId, ttlMs. Returns epoch, or -1 if held. */
export const ACQUIRE_SCRIPT = `
if redis.call('get', KEYS[1]) then return -1 end
local epoch = redis.call('incr', KEYS[2])
redis.call('set', KEYS[1], ARGV[1] .. ':' .. epoch, 'PX', ARGV[2])
redis.call('hset', KEYS[3], 'epoch', epoch, 'owner', ARGV[1])
return epoch
`;

/** KEYS: lock | ARGV: token, ttlMs. Returns 1 renewed, 0 lost. */
export const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

/** KEYS: lock, state | ARGV: token, ledger, ttlMs. 1 ok, -1 fenced, -2 rollback. */
export const STAGE_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return -1 end
local committed = tonumber(redis.call('hget', KEYS[2], 'committed') or '0')
local ledger = tonumber(ARGV[2])
if ledger < committed then return -2 end
redis.call('hset', KEYS[2], 'staged', ledger)
redis.call('pexpire', KEYS[1], ARGV[3])
return 1
`;

/** KEYS: lock, state | ARGV: token, ledger, ttlMs. 1 ok, -1 fenced, -2 rollback, -3 not staged. */
export const COMMIT_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return -1 end
local committed = tonumber(redis.call('hget', KEYS[2], 'committed') or '0')
local staged = tonumber(redis.call('hget', KEYS[2], 'staged') or '0')
local ledger = tonumber(ARGV[2])
if ledger < committed then return -2 end
if ledger > staged then return -3 end
redis.call('hset', KEYS[2], 'committed', ledger)
redis.call('pexpire', KEYS[1], ARGV[3])
return 1
`;

/** KEYS: lock, state | ARGV: token, finalLedger (or -1), releasedAtMs. 1 ok, -1 fenced, -2 rollback, -3 not staged. */
export const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return -1 end
local final = tonumber(ARGV[2])
if final >= 0 then
  local committed = tonumber(redis.call('hget', KEYS[2], 'committed') or '0')
  local staged = tonumber(redis.call('hget', KEYS[2], 'staged') or '0')
  if final < committed then return -2 end
  if final > staged then return -3 end
  redis.call('hset', KEYS[2], 'committed', final)
end
redis.call('del', KEYS[1])
redis.call('hset', KEYS[2], 'owner', '', 'releasedAt', ARGV[3])
return 1
`;

// ── Types ────────────────────────────────────────────────────────────────────

export type HandoverRole = 'shadow' | 'primary' | 'draining' | 'stopped';

export interface CursorRedisLike {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface CursorState {
  committed: number;
  staged: number;
  epoch: number;
  owner: string | null;
}

export interface PromotionInfo {
  nodeId: string;
  epoch: number;
  /** Ledger to resume from (the committed cursor). */
  resumeFrom: number;
  /** Window (committed, staged] a crashed predecessor may have partially processed; null when clean. */
  replayWindow: { from: number; to: number } | null;
}

export interface CursorCoordinatorOptions {
  redis: CursorRedisLike;
  nodeId?: string;
  keyPrefix?: string;
  leaseTtlMs?: number;
  /** How often a primary renews its lease. Defaults to a third of the TTL. */
  heartbeatIntervalMs?: number;
  /** How often a shadow re-checks whether the lease is free. */
  shadowPollMs?: number;
  /** Shadow observations of the committed cursor required before contending for the lease. */
  minShadowObservations?: number;
  /** Shadow readiness gate (DB reachable, registries loaded, …). Falsy/throwing = not ready. */
  warmup?: () => Promise<boolean> | boolean;
  onShadowObserved?: (state: CursorState) => void;
  onPromoted?: (info: PromotionInfo) => Promise<void> | void;
  onDemoted?: (reason: string) => Promise<void> | void;
  now?: () => number;
}

export class FencingError extends Error {
  constructor(message = 'Not the primary (lease lost or fenced by a newer epoch)') {
    super(message);
    this.name = 'FencingError';
  }
}

export class CursorRollbackError extends Error {
  constructor(ledger: number) {
    super(`Refusing to move the cursor backwards to ledger ${ledger}`);
    this.name = 'CursorRollbackError';
  }
}

export class CursorNotStagedError extends Error {
  constructor(ledger: number) {
    super(`Ledger ${ledger} was not staged before commit`);
    this.name = 'CursorNotStagedError';
  }
}

// ── Coordinator ──────────────────────────────────────────────────────────────

export class CursorHandoverCoordinator {
  readonly nodeId: string;
  private readonly redis: CursorRedisLike;
  private readonly lockKey: string;
  private readonly epochKey: string;
  private readonly stateKey: string;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly shadowPollMs: number;
  private readonly minShadowObservations: number;
  private readonly opts: CursorCoordinatorOptions;
  private readonly now: () => number;

  private _role: HandoverRole = 'stopped';
  private token: string | null = null;
  private _epoch = 0;
  private shadowObservations = 0;
  private shadowState: CursorState = { committed: 0, staged: 0, epoch: 0, owner: null };
  private lastRenewAt = 0;
  private lastStaged = 0;
  private lastCommitted = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: CursorCoordinatorOptions) {
    this.opts = options;
    this.redis = options.redis;
    this.nodeId = options.nodeId ?? `${process.pid}-${randomUUID().slice(0, 8)}`;
    const prefix = options.keyPrefix ?? 'watcher:cursor';
    this.lockKey = `${prefix}:lock`;
    this.epochKey = `${prefix}:epoch`;
    this.stateKey = `${prefix}:state`;
    this.leaseTtlMs = options.leaseTtlMs ?? 15_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(250, Math.floor(this.leaseTtlMs / 3));
    this.shadowPollMs = options.shadowPollMs ?? 500;
    this.minShadowObservations = options.minShadowObservations ?? 2;
    this.now = options.now ?? Date.now;
  }

  get role(): HandoverRole {
    return this._role;
  }

  get isPrimary(): boolean {
    return this._role === 'primary';
  }

  get epoch(): number {
    return this._epoch;
  }

  /** Last committed cursor this node knows of (primary: its own; shadow: last observed). */
  get committedCursor(): number {
    return this.isPrimary ? this.lastCommitted : this.shadowState.committed;
  }

  /**
   * Begins in SHADOW. With `autoTick` (default) a background loop drives
   * promotion/heartbeats; tests can pass false and call `tick()` themselves.
   */
  async start(options: { autoTick?: boolean } = {}): Promise<void> {
    if (this._role !== 'stopped') return;
    this._role = 'shadow';
    this.shadowObservations = 0;
    await this.tick();
    if (options.autoTick !== false) {
      const period = Math.min(this.shadowPollMs, this.heartbeatIntervalMs);
      this.timer = setInterval(() => void this.tick(), period);
      this.timer.unref?.();
    }
  }

  /** One scheduling step: shadows observe + try to promote, primaries heartbeat. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this._role === 'shadow') await this.shadowStep();
      else if (this._role === 'primary') await this.primaryStep();
    } catch (err) {
      log.warn({ nodeId: this.nodeId, err: err instanceof Error ? err.message : String(err) }, 'Coordinator tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Reads the shared cursor state. */
  async readState(): Promise<CursorState> {
    const raw = await this.redis.hgetall(this.stateKey);
    return {
      committed: Number(raw?.committed ?? 0),
      staged: Number(raw?.staged ?? 0),
      epoch: Number(raw?.epoch ?? 0),
      owner: raw?.owner ? raw.owner : null,
    };
  }

  /** Phase 1: declare the highest ledger the next batch intends to cover. */
  async stage(ledger: number): Promise<void> {
    this.assertPrimary();
    const result = await this.runFenced(STAGE_SCRIPT, ledger);
    this.interpret(result, ledger);
    this.lastStaged = ledger;
  }

  /** Phase 2: the staged batch is durable; advance the committed cursor. */
  async commit(ledger: number): Promise<void> {
    this.assertPrimary();
    const result = await this.runFenced(COMMIT_SCRIPT, ledger);
    this.interpret(result, ledger);
    this.lastCommitted = ledger;
  }

  /**
   * Graceful handover: stop acting as primary, optionally make a final commit
   * of work the caller has confirmed complete, and release the lease so a
   * shadow can take over immediately instead of waiting out the TTL.
   */
  async handOver(finalLedger?: number): Promise<{ released: boolean; committed: number }> {
    if (this._role !== 'primary') {
      this.shutdownTimers();
      this._role = 'stopped';
      return { released: false, committed: this.lastCommitted };
    }

    this._role = 'draining';
    this.shutdownTimers();

    try {
      if (finalLedger !== undefined && finalLedger > this.lastStaged) {
        try {
          const staged = await this.runFenced(STAGE_SCRIPT, finalLedger);
          this.interpret(staged, finalLedger);
          this.lastStaged = finalLedger;
        } catch (err) {
          // Never let a failed final stage strand the lease; release without a final commit.
          log.warn({ nodeId: this.nodeId, err: err instanceof Error ? err.message : String(err) }, 'Final stage failed; releasing without final commit');
          finalLedger = undefined;
        }
      }
      const release = async (final: number) =>
        Number(
          await this.redis.eval(RELEASE_SCRIPT, 2, this.lockKey, this.stateKey, this.token!, final, this.now()),
        );
      let result = await release(finalLedger ?? -1);
      if ((result === -2 || result === -3) && finalLedger !== undefined) {
        // The final commit was invalid (rollback / unstaged). Never strand the lease over it.
        log.warn({ nodeId: this.nodeId, finalLedger, result }, 'Final commit rejected; releasing without it');
        finalLedger = undefined;
        result = await release(-1);
      }
      if (result === 1) {
        if (finalLedger !== undefined) this.lastCommitted = finalLedger;
        log.info({ nodeId: this.nodeId, epoch: this._epoch, committed: this.lastCommitted }, '🤝 Primary lease handed over');
        return { released: true, committed: this.lastCommitted };
      }
      log.warn({ nodeId: this.nodeId, result }, 'Handover release was rejected; lease will expire on its own');
      return { released: false, committed: this.lastCommitted };
    } finally {
      this.token = null;
      this._role = 'stopped';
    }
  }

  /** Stops background work without releasing (used by tests / crash simulation). */
  stop(): void {
    this.shutdownTimers();
    this._role = 'stopped';
    this.token = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async shadowStep(): Promise<void> {
    const state = await this.readState();
    this.shadowState = state;
    this.shadowObservations++;
    this.opts.onShadowObserved?.(state);

    if (this.shadowObservations < this.minShadowObservations) return;
    if (!(await this.isWarm())) return;

    const result = Number(
      await this.redis.eval(ACQUIRE_SCRIPT, 3, this.lockKey, this.epochKey, this.stateKey, this.nodeId, this.leaseTtlMs),
    );
    if (result < 0) return; // another node is primary; keep shadowing

    this._epoch = result;
    this.token = `${this.nodeId}:${result}`;
    this._role = 'primary';
    this.lastRenewAt = this.now();

    // Re-read after acquiring: the previous primary's final commit is now visible and stable.
    const fresh = await this.readState();
    this.lastCommitted = fresh.committed;
    this.lastStaged = Math.max(fresh.staged, fresh.committed);
    const info: PromotionInfo = {
      nodeId: this.nodeId,
      epoch: result,
      resumeFrom: fresh.committed,
      replayWindow: fresh.staged > fresh.committed ? { from: fresh.committed, to: fresh.staged } : null,
    };
    log.info({ ...info }, '👑 Promoted to primary ingestion node');
    await this.opts.onPromoted?.(info);
  }

  private async primaryStep(): Promise<void> {
    if (this.now() - this.lastRenewAt < this.heartbeatIntervalMs) return;
    let renewed = false;
    try {
      renewed = Number(await this.redis.eval(RENEW_SCRIPT, 1, this.lockKey, this.token!, this.leaseTtlMs)) === 1;
    } catch (err) {
      // A transient Redis error must not instantly demote; the lease still has TTL left.
      log.warn({ nodeId: this.nodeId, err: err instanceof Error ? err.message : String(err) }, 'Lease renewal errored');
      if (this.now() - this.lastRenewAt < this.leaseTtlMs) return;
    }
    if (renewed) {
      this.lastRenewAt = this.now();
      return;
    }
    await this.demote('lease-lost');
  }

  private async demote(reason: string): Promise<void> {
    if (this._role !== 'primary') return;
    log.error({ nodeId: this.nodeId, epoch: this._epoch, reason }, '⬇️ Demoted from primary');
    this.token = null;
    this._role = 'shadow';
    this.shadowObservations = 0;
    await this.opts.onDemoted?.(reason);
  }

  private async isWarm(): Promise<boolean> {
    if (!this.opts.warmup) return true;
    try {
      return Boolean(await this.opts.warmup());
    } catch {
      return false;
    }
  }

  private assertPrimary(): void {
    if (this._role !== 'primary' || !this.token) throw new FencingError();
  }

  private async runFenced(script: string, ledger: number): Promise<number> {
    return Number(await this.redis.eval(script, 2, this.lockKey, this.stateKey, this.token!, ledger, this.leaseTtlMs));
  }

  private interpret(result: number, ledger: number): void {
    if (result === 1) return;
    if (result === -1) {
      void this.demote('fenced');
      throw new FencingError();
    }
    if (result === -2) throw new CursorRollbackError(ledger);
    if (result === -3) throw new CursorNotStagedError(ledger);
    throw new Error(`Unexpected cursor script result ${result}`);
  }

  private shutdownTimers(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
