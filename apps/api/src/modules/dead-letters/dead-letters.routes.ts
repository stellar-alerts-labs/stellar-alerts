import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { idempotencyHooks } from '../../middleware/idempotency.middleware';
import { deadLettersController } from './dead-letters.controller';
import { webhookSandboxController } from './webhook-sandbox.controller';

export async function deadLettersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  // Mutations carry the idempotency guard; reads do not (#334).
  const idempotent = idempotencyHooks();

  app.get('/dead-letters', deadLettersController.list.bind(deadLettersController));
  app.get('/dead-letters/:id', deadLettersController.get.bind(deadLettersController));
  app.post('/dead-letters/:id/replay', deadLettersController.replay.bind(deadLettersController));
  app.post('/dead-letters/:id/suppress', deadLettersController.suppress.bind(deadLettersController));

  // Webhook dead-letter sandbox replay inspector (#456). Static segments are
  // registered before /:id so Fastify never treats "sandbox-replays" as an id.
  app.post('/dead-letters/:id/replay-sandbox', webhookSandboxController.replaySandbox.bind(webhookSandboxController));
  app.get('/dead-letters/sandbox-replays', webhookSandboxController.listReplays.bind(webhookSandboxController));
  app.get('/dead-letters/sandbox-replays/:replayId', webhookSandboxController.getReplay.bind(webhookSandboxController));
}
