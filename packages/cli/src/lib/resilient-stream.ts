import { PaymentDTO } from './types.js';
import { CursorStore } from './cursor-store.js';

/** HTTP failure while opening the stream; `status` decides whether a retry can help. */
export class StreamHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'StreamHttpError';
  }
}

export function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof StreamHttpError) {
    return error.status >= 500 || error.status === 429 || error.status === 408;
  }
  // Network resets, DNS failures, premature EOF, etc.
  return true;
}

/** Exponential backoff with equal jitter: the delay lands in [cap/2, cap]. */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(cap / 2 + random() * (cap / 2));
}

/** Insertion-ordered set that forgets its oldest entries past `capacity`. */
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity: number) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.capacity) {
      this.ids.delete(this.ids.values().next().value as string);
    }
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ReconnectInfo {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface ResilientStreamOptions {
  /** Opens one connection resuming after `cursor` (undefined = live tail). */
  connect: (cursor: string | undefined, signal: AbortSignal) => Promise<AsyncIterable<PaymentDTO>>;
  onPayment: (payment: PaymentDTO) => void | Promise<void>;
  signal: AbortSignal;
  /** Omit to disable cursor persistence. */
  store?: CursorStore;
  /** Takes precedence over the stored cursor. */
  initialCursor?: string;
  /** Consecutive failed attempts tolerated before giving up. Default: unlimited. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  dedupWindow?: number;
  onConnected?: (cursor: string | undefined) => void;
  onReconnect?: (info: ReconnectInfo) => void;
  onWarning?: (message: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface ResilientStreamResult {
  received: number;
  suppressed: number;
  cursor: string | undefined;
}

/**
 * Consumes the payment stream until `signal` aborts, reconnecting with backoff
 * and resuming from the last fully handled payment. Delivery is at-least-once:
 * the checkpoint is written only after `onPayment` returns, and replays around a
 * reconnect are dropped by payment id.
 */
export async function runResilientStream(options: ResilientStreamOptions): Promise<ResilientStreamResult> {
  const {
    connect,
    onPayment,
    signal,
    store,
    maxRetries = Infinity,
    baseDelayMs = 1_000,
    maxDelayMs = 60_000,
    dedupWindow = 1_000,
    onConnected,
    onReconnect,
    onWarning = () => {},
    sleep = abortableSleep,
    random = Math.random,
  } = options;

  const seen = new RecentIds(dedupWindow);
  const stored = store ? await store.load() : null;
  let cursor = options.initialCursor ?? stored?.cursor;
  if (stored && options.initialCursor === undefined) {
    seen.add(stored.lastId);
  }

  let received = 0;
  let suppressed = 0;
  let attempt = 0;

  while (!signal.aborted) {
    let failure: unknown;
    let handlerError: unknown;

    try {
      const payments = await connect(cursor, signal);
      onConnected?.(cursor);

      for await (const payment of payments) {
        // A healthy connection that delivers data resets the backoff.
        attempt = 0;

        if (seen.has(payment.id)) {
          suppressed++;
        } else {
          try {
            await onPayment(payment);
          } catch (error) {
            handlerError = error;
            break;
          }
          seen.add(payment.id);
          received++;
          cursor = payment.pagingToken ?? payment.id;
          if (store) {
            try {
              await store.save({ cursor, lastId: payment.id });
            } catch (error) {
              onWarning(`Failed to persist stream cursor: ${(error as Error).message}`);
            }
          }
        }

        if (signal.aborted) break;
      }

      if (handlerError !== undefined) throw handlerError;
      if (signal.aborted) break;
      failure = new Error('Stream closed by server');
    } catch (error) {
      if (handlerError !== undefined) throw error;
      if (signal.aborted) break;
      if (!isRetryableStreamError(error)) throw error;
      failure = error;
    }

    attempt++;
    if (attempt > maxRetries) {
      throw new Error(
        `Giving up after ${maxRetries} reconnect attempt(s): ${(failure as Error)?.message ?? String(failure)}`
      );
    }

    const delayMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, random);
    onReconnect?.({ attempt, delayMs, error: failure });
    await sleep(delayMs, signal);
  }

  return { received, suppressed, cursor };
}
