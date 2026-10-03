import { webhookBatchingService, AggregatedWebhookPayload } from './webhook-batching.service';

/**
 * Adapter that listens to batching flushes and forwards them to a handler.
 * In this patch we keep it simple: expose `onFlush` to register a dispatcher.
 */
export function onAggregatedFlush(handler: (payload: AggregatedWebhookPayload) => Promise<void> | void) {
  webhookBatchingService.on('flush', async (payload: AggregatedWebhookPayload) => {
    try {
      await handler(payload);
    } catch (err) {
      // noop for now; production should log and retry
      // eslint-disable-next-line no-console
      console.error('[webhook-batching.adapter] handler error', (err as Error).message);
    }
  });
}
