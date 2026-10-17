import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { idempotencyHooks } from '../../middleware/idempotency.middleware';
import { webhooksController } from './webhooks.controller';

export async function webhooksRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  // Mutations carry the idempotency guard; reads do not (#334).
  const idempotent = idempotencyHooks();

  app.post(
    '/webhooks',
    {
      schema: { tags: ['webhooks'], summary: 'Register a webhook endpoint', description: 'Adds a new webhook URL to receive signed payment alert payloads.' },
      preValidation: idempotent.preValidation, onSend: idempotent.onSend, onResponse: idempotent.onResponse,
    },
    webhooksController.addWebhook.bind(webhooksController)
  );
  app.get('/webhooks', { schema: { tags: ['webhooks'], summary: 'List webhook endpoints', description: 'Returns all registered webhook endpoints for the authenticated user.' } }, webhooksController.getWebhooks.bind(webhooksController));
  app.delete(
    '/webhooks/:id',
    {
      schema: { tags: ['webhooks'], summary: 'Delete a webhook endpoint', description: 'Permanently removes the specified webhook endpoint.' },
      preValidation: idempotent.preValidation, onSend: idempotent.onSend, onResponse: idempotent.onResponse,
    },
    webhooksController.deleteWebhook.bind(webhooksController)
  );
  // Deliberately excluded: this route triggers an outbound delivery. It is a
  // diagnostic probe whose whole purpose is to send, so replaying a stored
  // response would make the second press look like it worked when nothing ran.
  app.post('/webhooks/:id/test', { schema: { tags: ['webhooks'], summary: 'Send a test delivery', description: 'Dispatches a test payload to the webhook URL to verify connectivity and signature verification.' } }, webhooksController.testWebhook.bind(webhooksController));
  app.get('/webhooks/:id/logs', { schema: { tags: ['webhooks'], summary: 'Get webhook delivery logs', description: 'Returns recent delivery attempts and response codes for the specified webhook.' } }, webhooksController.getWebhookLogs.bind(webhooksController));
}
