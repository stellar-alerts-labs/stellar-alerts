import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { idempotencyHooks } from '../../middleware/idempotency.middleware';
import { deadLettersController } from './dead-letters.controller';
import { webhookSandboxController } from './webhook-sandbox.controller';

export async function deadLettersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  // Mutations carry the idempotency guard; reads do not (#334).
  const idempotent = idempotencyHooks();

  app.get('/dead-letters', { schema: { tags: ['dead-letters'], summary: 'List dead letters', description: 'Returns paginated terminal delivery failures for the authenticated user.' } }, deadLettersController.list.bind(deadLettersController));
  app.get('/dead-letters/:id', { schema: { tags: ['dead-letters'], summary: 'Get a dead letter', description: 'Returns details and failure metadata for a single dead-letter record.' } }, deadLettersController.get.bind(deadLettersController));
  app.post('/dead-letters/:id/replay', { schema: { tags: ['dead-letters'], summary: 'Replay a dead letter', description: 'Re-enqueues the original alert job for re-delivery idempotently.' } }, deadLettersController.replay.bind(deadLettersController));
  app.post('/dead-letters/:id/suppress', { schema: { tags: ['dead-letters'], summary: 'Suppress a dead letter', description: 'Marks the dead letter as suppressed so it is excluded from future replays.' } }, deadLettersController.suppress.bind(deadLettersController));

  // Webhook dead-letter sandbox replay inspector (#456). Static segments are
  // registered before /:id so Fastify never treats "sandbox-replays" as an id.
  app.post('/dead-letters/:id/replay-sandbox', { schema: { tags: ['webhook-sandbox'], summary: 'Sandbox replay', description: 'Replays a dead letter against a mock webhook receiver for inspection without side effects.' } }, webhookSandboxController.replaySandbox.bind(webhookSandboxController));
  app.get('/dead-letters/sandbox-replays', { schema: { tags: ['webhook-sandbox'], summary: 'List sandbox replays', description: 'Returns paginated sandbox replay records for the authenticated user.' } }, webhookSandboxController.listReplays.bind(webhookSandboxController));
  app.get('/dead-letters/sandbox-replays/:replayId', { schema: { tags: ['webhook-sandbox'], summary: 'Get a sandbox replay', description: 'Returns the request/response details for a specific sandbox replay.' } }, webhookSandboxController.getReplay.bind(webhookSandboxController));
}
