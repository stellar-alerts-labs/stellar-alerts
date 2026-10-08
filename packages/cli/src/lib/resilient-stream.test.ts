import { describe, it, expect, vi } from 'vitest';
import {
  runResilientStream,
  computeBackoffDelay,
  RecentIds,
  StreamHttpError,
  abortableSleep,
  ResilientStreamOptions,
} from './resilient-stream.js';
import { CursorStore, StreamCursor } from './cursor-store.js';
import { PaymentDTO } from './types.js';

function payment(id: string, extra: Partial<PaymentDTO> = {}): PaymentDTO {
  return {
    id,
    walletId: 'w1',
    txHash: `tx-${id}`,
    fromAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
    amount: '1',
    asset: 'XLM',
    receivedAt: '2026-09-25T00:00:00.000Z',
    ...extra,
  };
}

/** One scripted connection: yields `payments`, then throws `thenError` or ends. */
type Script = { payments?: PaymentDTO[]; thenError?: Error } | Error;

function scriptedConnect(scripts: Script[]) {
  const cursors: Array<string | undefined> = [];
  let closed = 0;
  const connect = vi.fn(async (cursor: string | undefined) => {
    cursors.push(cursor);
    const script = scripts.shift();
    if (!script) throw new Error('no more scripted connections');
    if (script instanceof Error) throw script;
    return (async function* () {
      try {
        for (const p of script.payments ?? []) yield p;
        if (script.thenError) throw script.thenError;
      } finally {
        closed++;
      }
    })();
  });
  return { connect, cursors, closedCount: () => closed };
}

class MemoryStore extends CursorStore {
  saved: Array<Omit<StreamCursor, 'updatedAt'>> = [];
  constructor(private initial: StreamCursor | null = null) {
    super('memory');
  }
  override async load() {
    return this.initial;
  }
  override async save(checkpoint: Omit<StreamCursor, 'updatedAt'>) {
    this.saved.push(checkpoint);
  }
  get last() {
    return this.saved[this.saved.length - 1];
  }
}

/** Runs the stream and aborts once `connect` has been called `connections` times and drained. */
function harness(scripts: Script[], overrides: Partial<ResilientStreamOptions> = {}) {
  const controller = new AbortController();
  const scripted = scriptedConnect(scripts);
  const delays: number[] = [];
  const handled: string[] = [];
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms);
    // Stop once every scripted connection has been used.
    if (scripts.length === 0) controller.abort();
  });
  const run = () =>
    runResilientStream({
      connect: scripted.connect,
      onPayment: (p) => {
        handled.push(p.id);
      },
      signal: controller.signal,
      sleep,
      random: () => 1,
      ...overrides,
    });
  return { controller, scripted, delays, handled, sleep, run };
}

const drop = () => new Error('socket hang up');

describe('computeBackoffDelay', () => {
  it('doubles per attempt and is capped at maxDelayMs', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((a) => computeBackoffDelay(a, 1000, 60_000, () => 1));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it('applies jitter within [cap/2, cap]', () => {
    expect(computeBackoffDelay(3, 1000, 60_000, () => 0)).toBe(2000);
    expect(computeBackoffDelay(3, 1000, 60_000, () => 0.5)).toBe(3000);
  });
});

describe('RecentIds', () => {
  it('evicts the oldest ids beyond capacity', () => {
    const ids = new RecentIds(2);
    ids.add('a');
    ids.add('b');
    ids.add('c');
    expect(ids.has('a')).toBe(false);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
  });
});

describe('abortableSleep', () => {
  it('resolves immediately on abort and leaves no pending timer', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = abortableSleep(60_000, controller.signal);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runResilientStream', () => {
  describe('reconnect with backoff', () => {
    it('reconnects after connection failures with growing delays', async () => {
      const h = harness([drop(), drop(), drop(), { payments: [payment('p1')] }]);
      await h.run();
      expect(h.scripted.connect).toHaveBeenCalledTimes(4);
      // Three failures back off 1s, 2s, 4s; the final clean close resets to 1s.
      expect(h.delays).toEqual([1000, 2000, 4000, 1000]);
      expect(h.handled).toEqual(['p1']);
    });

    it('caps the delay at maxDelayMs', async () => {
      const h = harness([drop(), drop(), drop(), drop()], { maxDelayMs: 3000 });
      await h.run();
      expect(h.delays).toEqual([1000, 2000, 3000, 3000]);
    });

    it('resets backoff after a connection delivers data', async () => {
      const h = harness([
        drop(),
        drop(),
        { payments: [payment('p1')], thenError: drop() },
        drop(),
      ]);
      await h.run();
      expect(h.delays).toEqual([1000, 2000, 1000, 2000]);
    });

    it('treats a server-side close as a drop and reconnects', async () => {
      const h = harness([{ payments: [payment('p1')] }, { payments: [payment('p2')] }]);
      await h.run();
      expect(h.handled).toEqual(['p1', 'p2']);
      expect(h.scripted.connect).toHaveBeenCalledTimes(2);
    });

    it('retries 5xx and 429 but fails fast on auth errors without sleeping', async () => {
      const retry = harness([new StreamHttpError('busy', 503), new StreamHttpError('slow down', 429)]);
      await retry.run();
      expect(retry.delays).toHaveLength(2);

      const fatal = harness([new StreamHttpError('Unauthorized', 401)]);
      await expect(fatal.run()).rejects.toThrow('Unauthorized');
      expect(fatal.sleep).not.toHaveBeenCalled();
    });

    it('gives up after maxRetries consecutive failures', async () => {
      const h = harness([drop(), drop(), drop(), drop()], { maxRetries: 2 });
      await expect(h.run()).rejects.toThrow(/Giving up after 2 reconnect attempt\(s\): socket hang up/);
      expect(h.scripted.connect).toHaveBeenCalledTimes(3);
    });
  });

  describe('cursor persistence and resume', () => {
    it('starts from the live tail when no cursor is stored (legacy behaviour)', async () => {
      const store = new MemoryStore(null);
      const h = harness([{ payments: [payment('p1')] }], { store });
      await h.run();
      expect(h.scripted.cursors[0]).toBeUndefined();
    });

    it('resumes exactly after the saved cursor and checkpoints each handled payment', async () => {
      const store = new MemoryStore({ cursor: 'tok-5', lastId: 'p5', updatedAt: '' });
      const h = harness(
        [
          { payments: [payment('p6', { pagingToken: 'tok-6' }), payment('p7')], thenError: drop() },
          { payments: [] },
        ],
        { store }
      );
      await h.run();
      expect(h.scripted.cursors).toEqual(['tok-5', 'p7']);
      // pagingToken is preferred; id is the fallback.
      expect(store.saved).toEqual([
        { cursor: 'tok-6', lastId: 'p6' },
        { cursor: 'p7', lastId: 'p7' },
      ]);
    });

    it('--cursor overrides the stored cursor', async () => {
      const store = new MemoryStore({ cursor: 'tok-5', lastId: 'p5', updatedAt: '' });
      const h = harness([{ payments: [payment('p5')] }], { store, initialCursor: 'tok-1' });
      await h.run();
      expect(h.scripted.cursors[0]).toBe('tok-1');
      // Seeding from the stored lastId is skipped when the user picked a cursor.
      expect(h.handled).toEqual(['p5']);
    });

    it('does not advance the cursor past a payment whose handler crashed', async () => {
      const store = new MemoryStore(null);
      const controller = new AbortController();
      const { connect, closedCount } = scriptedConnect([
        { payments: [payment('p1'), payment('p2'), payment('p3')] },
      ]);

      await expect(
        runResilientStream({
          connect,
          signal: controller.signal,
          store,
          onPayment: (p) => {
            if (p.id === 'p2') throw new Error('handler exploded');
          },
          sleep: async () => {},
        })
      ).rejects.toThrow('handler exploded');

      expect(store.saved).toEqual([{ cursor: 'p1', lastId: 'p1' }]);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(closedCount()).toBe(1);
    });

    it('keeps streaming when the checkpoint cannot be written', async () => {
      const store = new MemoryStore(null);
      store.save = async () => {
        throw new Error('disk full');
      };
      const warnings: string[] = [];
      const h = harness([{ payments: [payment('p1'), payment('p2')] }], {
        store,
        onWarning: (m) => warnings.push(m),
      });
      await h.run();
      expect(h.handled).toEqual(['p1', 'p2']);
      expect(warnings[0]).toContain('disk full');
    });
  });

  describe('duplicate suppression', () => {
    it('drops records replayed by the server after a reconnect', async () => {
      const h = harness([
        { payments: [payment('p1'), payment('p2')], thenError: drop() },
        { payments: [payment('p2'), payment('p3')] },
      ]);
      const result = await h.run();
      expect(h.handled).toEqual(['p1', 'p2', 'p3']);
      expect(result.suppressed).toBe(1);
      expect(result.received).toBe(3);
    });

    it('drops the last handled record when replayed after a process restart', async () => {
      const store = new MemoryStore({ cursor: 'p5', lastId: 'p5', updatedAt: '' });
      const h = harness([{ payments: [payment('p5'), payment('p6')] }], { store });
      const result = await h.run();
      expect(h.handled).toEqual(['p6']);
      expect(result.suppressed).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('finishes the in-flight record, flushes its cursor and closes the connection on abort', async () => {
      const store = new MemoryStore(null);
      const controller = new AbortController();
      const { connect, closedCount } = scriptedConnect([
        { payments: [payment('p1'), payment('p2'), payment('p3')] },
      ]);
      const handled: string[] = [];

      const result = await runResilientStream({
        connect,
        signal: controller.signal,
        store,
        onPayment: async (p) => {
          if (p.id === 'p2') controller.abort();
          await Promise.resolve();
          handled.push(p.id);
        },
        sleep: async () => {
          throw new Error('should not back off after shutdown');
        },
      });

      expect(handled).toEqual(['p1', 'p2']);
      expect(store.last).toEqual({ cursor: 'p2', lastId: 'p2' });
      expect(result).toEqual({ received: 2, suppressed: 0, cursor: 'p2' });
      expect(closedCount()).toBe(1);
    });

    it('stops while waiting to reconnect', async () => {
      const controller = new AbortController();
      const { connect } = scriptedConnect([drop(), drop()]);
      const run = runResilientStream({
        connect,
        onPayment: () => {},
        signal: controller.signal,
        baseDelayMs: 60_000,
      });
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await expect(run).resolves.toMatchObject({ received: 0 });
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('treats an AbortError raised by the transport as a clean stop', async () => {
      const controller = new AbortController();
      const connect = vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      });
      await expect(
        runResilientStream({ connect, onPayment: () => {}, signal: controller.signal })
      ).resolves.toMatchObject({ received: 0 });
    });
  });
});
