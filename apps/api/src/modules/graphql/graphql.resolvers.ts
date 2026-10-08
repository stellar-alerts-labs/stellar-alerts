import { Redis } from 'ioredis';
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
 * Creates an async generator that yields messages published to a Redis pub/sub channel.
 * ioredis subscriber clients are not async iterables, so we bridge with a queue + event.
 */
async function* redisChannelIterator(
  subscriber: Redis,
  channel: string,
): AsyncGenerator<string> {
  const queue: string[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  subscriber.on('message', (_ch: string, msg: string) => {
    if (_ch !== channel) return;
    queue.push(msg);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  });

  subscriber.on('end', () => {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  });

  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
    } else if (done) {
      return;
    } else {
      await new Promise<void>((res) => {
        resolve = res;
      });
    }
  }
}

export const createResolvers = (redis: Redis) => ({
  Query: {
    health: () => 'ok',
  },
  Subscription: {
    paymentStream: {
      subscribe: async (_: unknown, { filter }: { filter?: PaymentFilter }) => {
        const subscriber = redis.duplicate();
        await subscriber.subscribe('payments');

        const asyncIterator = {
          [Symbol.asyncIterator]: async function* () {
            try {
              for await (const message of redisChannelIterator(subscriber, 'payments')) {
                const payment = JSON.parse(message);

                if (filter) {
                  if (filter.walletId && payment.walletId !== filter.walletId) continue;
                  if (filter.asset && payment.asset !== filter.asset) continue;
                  if (filter.minAmount && parseFloat(payment.amount) < filter.minAmount) continue;
                }

                yield payment;
              }
            } finally {
              await subscriber.quit();
            }
          },
        };

        return asyncIterator;
      },
    },
    sorobanEventStream: {
      subscribe: async (_: unknown, { filter }: { filter?: SorobanEventFilter }) => {
        const subscriber = redis.duplicate();
        await subscriber.subscribe('soroban_events');

        const asyncIterator = {
          [Symbol.asyncIterator]: async function* () {
            try {
              for await (const message of redisChannelIterator(subscriber, 'soroban_events')) {
                const event = JSON.parse(message);

                if (filter) {
                  if (filter.contractId && event.contractId !== filter.contractId) continue;
                  if (filter.topicSymbol && event.topicSymbol !== filter.topicSymbol) continue;
                }

                yield event;
              }
            } finally {
              await subscriber.quit();
            }
          },
        };

        return asyncIterator;
      },
    },
    systemMetrics: {
      subscribe: async () => {
        const subscriber = redis.duplicate();
        await subscriber.subscribe('system_metrics');

        const asyncIterator = {
          [Symbol.asyncIterator]: async function* () {
            try {
              for await (const message of redisChannelIterator(subscriber, 'system_metrics')) {
                yield JSON.parse(message);
              }
            } finally {
              await subscriber.quit();
            }
          },
        };

        return asyncIterator;
      },
    },
  },
});

// Satisfy the import so prisma tree-shaking keeps it available
void prisma;
