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

export const createResolvers = (redis: Redis) => ({
  Query: {
    health: () => 'ok',
  },
  Subscription: {
    paymentStream: {
      subscribe: async (_: any, { filter }: { filter?: PaymentFilter }) => {
        const pubsub = redis.duplicate();
        const channel = 'payments';

        const asyncIterator = {
          // ioredis 6 typings dropped Symbol.asyncIterator, but the runtime
          // subscriber still iterates message-by-message.
          [Symbol.asyncIterator]: async function* () {
            const subscriber = pubsub.duplicate() as unknown as Redis & AsyncIterable<string>;
            await subscriber.subscribe(channel);

            try {
              for await (const message of subscriber) {
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
      subscribe: async (_: any, { filter }: { filter?: SorobanEventFilter }) => {
        const pubsub = redis.duplicate();
        const channel = 'soroban_events';

        const asyncIterator = {
          [Symbol.asyncIterator]: async function* () {
            const subscriber = pubsub.duplicate() as unknown as Redis & AsyncIterable<string>;
            await subscriber.subscribe(channel);

            try {
              for await (const message of subscriber) {
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
        const pubsub = redis.duplicate();
        const channel = 'system_metrics';

        const asyncIterator = {
          [Symbol.asyncIterator]: async function* () {
            const subscriber = pubsub.duplicate() as unknown as Redis & AsyncIterable<string>;
            await subscriber.subscribe(channel);

            try {
              for await (const message of subscriber) {
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
