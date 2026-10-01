import type { Redis } from 'ioredis';
import { prisma } from '../../lib/prisma';

interface PaymentFilter {
  walletId?: string;
  asset?: string;
  minAmount?: number;
}

interface SorobanEventFilter {
  contractId?: string;
  topicSymbol?: string;
}

/**
 * Builds an `AsyncIterableIterator` over a Redis pub/sub channel.
 *
 * `ioredis` publishes messages through its `message` event and does not
 * implement `Symbol.asyncIterator` itself, so the messages are drained off an
 * in-memory queue. `transform` returns `null` to drop a message that the
 * subscription's filter rejects — dropping happens before the queue, so a
 * filtered subscription never yields a `null` payload downstream. The queue is
 * unbounded to match pub/sub semantics (a slow consumer must not silently lose
 * published payments), and `return()` both unsubscribes and closes the socket
 * so a disconnecting subscription does not leak a connection per subscriber.
 */
function createChannelIterator(
  redis: Redis,
  channel: string,
  transform: (payload: string) => Record<string, unknown> | null,
): AsyncIterableIterator<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  let done = false;
  let notify: (() => void) | null = null;

  const wake = () => {
    const resume = notify;
    notify = null;
    resume?.();
  };

  const subscriber = redis.duplicate();

  subscriber.on('message', (incomingChannel: string, message: string) => {
    if (incomingChannel !== channel || done) return;
    const value = transform(message);
    if (value === null) return;
    queue.push(value);
    wake();
  });

  const cleanup = async () => {
    if (done) return;
    done = true;
    wake();
    try {
      await subscriber.unsubscribe(channel);
    } catch {
      // The socket may already be closing; quitting below is sufficient.
    }
    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  };

  const subscribe = (async () => {
    await subscriber.subscribe(channel);
  })();

  const iterator: AsyncIterableIterator<Record<string, unknown>> = {
    async next() {
      await subscribe;
      while (queue.length === 0) {
        if (done) return { done: true, value: undefined };
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const value = queue.shift() as Record<string, unknown>;
      return { done: false, value };
    },
    async return() {
      await cleanup();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return iterator;
}

export const createResolvers = (redis: Redis) => ({
  Query: {
    health: () => 'ok',
  },
  Subscription: {
    paymentStream: {
      subscribe: async (_: unknown, { filter }: { filter?: PaymentFilter }) =>
        createChannelIterator(redis, 'payments', (message) => {
          const payment = JSON.parse(message) as Record<string, unknown>;

          if (filter) {
            if (filter.walletId && payment.walletId !== filter.walletId) return null;
            if (filter.asset && payment.asset !== filter.asset) return null;
            if (filter.minAmount && Number(payment.amount) < filter.minAmount) return null;
          }

          return payment;
        }),
    },
    sorobanEventStream: {
      subscribe: async (_: unknown, { filter }: { filter?: SorobanEventFilter }) =>
        createChannelIterator(redis, 'soroban_events', (message) => {
          const event = JSON.parse(message) as Record<string, unknown>;

          if (filter) {
            if (filter.contractId && event.contractId !== filter.contractId) return null;
            if (filter.topicSymbol && event.topicSymbol !== filter.topicSymbol) return null;
          }

          return event;
        }),
    },
    systemMetrics: {
      subscribe: async () =>
        createChannelIterator(redis, 'system_metrics', (message) =>
          JSON.parse(message) as Record<string, unknown>,
        ),
    },
  },
});

// Satisfy the import so prisma tree-shaking keeps it available
void prisma;
