import { prisma, prismaRead, setReadTarget } from './prisma';
import { redis } from './redis';

/**
 * Active-passive database failover controller.
 *
 * Probes the primary PostgreSQL cluster. After `failureThreshold` consecutive
 * failed probes the controller declares a partition: reads are rerouted to the
 * replica, the API enters read-only degraded mode, and state mutations are
 * buffered in a Redis list. After `recoveryThreshold` consecutive healthy
 * probes the buffer is replayed in order and normal operation resumes.
 */

export type FailoverState = 'HEALTHY' | 'DEGRADED_READ_ONLY';

export interface FailoverConfig {
  probeIntervalMs: number;
  probeTimeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  bufferKey: string;
  maxBufferSize: number;
}

export interface BufferedMutation {
  id: string;
  type: string;
  payload: unknown;
  bufferedAt: string;
}

export interface FailoverStatus {
  state: FailoverState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastProbeAt: Date | null;
  degradedSince: Date | null;
  lastError: string | null;
  bufferedMutations: number;
}

export type MutationHandler = (payload: unknown) => Promise<void>;
export type ProbeFn = () => Promise<void>;

/** Minimal Redis list surface so tests can inject an in-memory buffer. */
export interface MutationBufferStore {
  push(key: string, value: string): Promise<void>;
  shift(key: string): Promise<string | null>;
  unshift(key: string, value: string): Promise<void>;
  length(key: string): Promise<number>;
}

export const redisMutationStore: MutationBufferStore = {
  async push(key, value) {
    await redis.rpush(key, value);
  },
  async shift(key) {
    return redis.lpop(key);
  },
  async unshift(key, value) {
    await redis.lpush(key, value);
  },
  async length(key) {
    return redis.llen(key);
  },
};

const defaultConfig: FailoverConfig = {
  probeIntervalMs: Number(process.env.DB_FAILOVER_PROBE_INTERVAL_MS) || 5000,
  probeTimeoutMs: Number(process.env.DB_FAILOVER_PROBE_TIMEOUT_MS) || 2000,
  failureThreshold: Number(process.env.DB_FAILOVER_FAILURE_THRESHOLD) || 3,
  recoveryThreshold: Number(process.env.DB_FAILOVER_RECOVERY_THRESHOLD) || 2,
  bufferKey: 'db:failover:mutation-buffer',
  maxBufferSize: Number(process.env.DB_FAILOVER_MAX_BUFFER) || 10000,
};

async function defaultProbe(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export class DbFailoverController {
  private state: FailoverState = 'HEALTHY';
  private failures = 0;
  private successes = 0;
  private lastProbeAt: Date | null = null;
  private degradedSince: Date | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private replaying = false;
  private handlers = new Map<string, MutationHandler>();
  private listeners = new Set<(status: FailoverStatus) => void>();

  constructor(
    private readonly config: FailoverConfig = defaultConfig,
    private readonly probe: ProbeFn = defaultProbe,
    private readonly store: MutationBufferStore = redisMutationStore,
    private readonly onReroute: (target: 'PRIMARY' | 'REPLICA') => void = setReadTarget
  ) {}

  /** Registers the function used to re-apply a buffered mutation of `type` once the primary is back. */
  registerMutationHandler(type: string, handler: MutationHandler): void {
    this.handlers.set(type, handler);
  }

  onStateChange(listener: (status: FailoverStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isReadOnly(): boolean {
    return this.state === 'DEGRADED_READ_ONLY';
  }

  async getStatus(): Promise<FailoverStatus> {
    let buffered = 0;
    try {
      buffered = await this.store.length(this.config.bufferKey);
    } catch {
      // Redis unavailable; report zero rather than failing the health endpoint.
    }
    return {
      state: this.state,
      consecutiveFailures: this.failures,
      consecutiveSuccesses: this.successes,
      lastProbeAt: this.lastProbeAt,
      degradedSince: this.degradedSince,
      lastError: this.lastError,
      bufferedMutations: buffered,
    };
  }

  private async runProbe(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Primary probe timed out')), this.config.probeTimeoutMs);
    });
    try {
      await Promise.race([this.probe(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Runs one health probe and applies state transitions. Exposed for tests and manual triggering. */
  async check(): Promise<FailoverStatus> {
    this.lastProbeAt = new Date();
    try {
      await this.runProbe();
      this.failures = 0;
      this.successes++;
      this.lastError = null;
      if (this.state === 'DEGRADED_READ_ONLY' && this.successes >= this.config.recoveryThreshold) {
        await this.recover();
      }
    } catch (err) {
      this.successes = 0;
      this.failures++;
      this.lastError = (err as Error).message;
      if (this.state === 'HEALTHY' && this.failures >= this.config.failureThreshold) {
        this.enterDegradedMode();
      }
    }
    return this.getStatus();
  }

  private enterDegradedMode(): void {
    this.state = 'DEGRADED_READ_ONLY';
    this.degradedSince = new Date();
    this.onReroute('REPLICA');
    console.error(
      `[DB Failover] 🚨 Primary unreachable after ${this.failures} probes (${this.lastError}). Read-only degraded mode active; reads routed to replica.`
    );
    void this.notify();
  }

  private async recover(): Promise<void> {
    if (this.replaying) return;
    this.replaying = true;
    try {
      const drained = await this.replayBuffered();
      if (!drained) return; // stay read-only until every buffered mutation is applied
      this.state = 'HEALTHY';
      this.degradedSince = null;
      this.onReroute('REPLICA');
      console.log('[DB Failover] 🟢 Primary recovered and buffered mutations replayed. Resuming normal operation.');
      await this.notify();
    } finally {
      this.replaying = false;
    }
  }

  /**
   * Replays buffered mutations in FIFO order. On the first failure the entry is
   * put back at the head of the queue so ordering is preserved on the next attempt.
   * Returns true when the buffer is fully drained.
   */
  async replayBuffered(): Promise<boolean> {
    for (;;) {
      const raw = await this.store.shift(this.config.bufferKey);
      if (raw === null) return true;

      let mutation: BufferedMutation;
      try {
        mutation = JSON.parse(raw) as BufferedMutation;
      } catch {
        console.warn('[DB Failover] Dropping unparseable buffered mutation');
        continue;
      }

      const handler = this.handlers.get(mutation.type);
      if (!handler) {
        console.warn(`[DB Failover] No handler for buffered mutation type "${mutation.type}"; dropping ${mutation.id}`);
        continue;
      }

      try {
        await handler(mutation.payload);
      } catch (err) {
        console.error(`[DB Failover] Replay of ${mutation.id} failed, will retry: ${(err as Error).message}`);
        await this.store.unshift(this.config.bufferKey, raw);
        this.successes = 0;
        return false;
      }
    }
  }

  /**
   * Buffers a state mutation for later replay. Returns the buffered record, or
   * throws when the buffer is full so callers can surface a 503 instead of losing data.
   */
  async bufferMutation(type: string, payload: unknown): Promise<BufferedMutation> {
    const size = await this.store.length(this.config.bufferKey);
    if (size >= this.config.maxBufferSize) {
      throw new Error('Mutation buffer is full');
    }
    const mutation: BufferedMutation = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      type,
      payload,
      bufferedAt: new Date().toISOString(),
    };
    await this.store.push(this.config.bufferKey, JSON.stringify(mutation));
    return mutation;
  }

  private async notify(): Promise<void> {
    const status = await this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // Listener errors must not break the controller.
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.config.probeIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const dbFailover = new DbFailoverController();

/** Replica client used for reads while the primary is partitioned. */
export function getDegradedReadClient() {
  return prismaRead;
}
