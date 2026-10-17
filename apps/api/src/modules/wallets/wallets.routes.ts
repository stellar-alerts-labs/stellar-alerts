import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { idempotencyHooks } from '../../middleware/idempotency.middleware';
import { walletsController } from './wallets.controller';

export async function walletsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  // Idempotency only guards mutations: a retried read has no side effect to
  // deduplicate, so those routes skip the extra database round trip (#334).
  const idempotent = idempotencyHooks();

  app.post(
    '/wallets',
    {
      schema: { tags: ['wallets'], summary: 'Register a wallet', description: 'Adds a Stellar public key to the authenticated user\'s watch list.' },
      preValidation: idempotent.preValidation, onSend: idempotent.onSend, onResponse: idempotent.onResponse,
    },
    walletsController.addWallet.bind(walletsController)
  );
  app.get('/wallets', { schema: { tags: ['wallets'], summary: 'List watched wallets', description: 'Returns all Stellar wallets registered to the authenticated user.' } }, walletsController.getWallets.bind(walletsController));
  app.get('/wallets/:id/ingestion-status', { schema: { tags: ['wallets'], summary: 'Get wallet ingestion status', description: 'Returns the current Horizon cursor position and ingestion health for a wallet.' } }, walletsController.getIngestionStatus.bind(walletsController));
  app.delete(
    '/wallets/:id',
    {
      schema: { tags: ['wallets'], summary: 'Remove a watched wallet', description: 'Stops monitoring the specified wallet and removes it from the watch list.' },
      preValidation: idempotent.preValidation, onSend: idempotent.onSend, onResponse: idempotent.onResponse,
    },
    walletsController.deleteWallet.bind(walletsController)
  );
}
