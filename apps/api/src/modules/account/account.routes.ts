import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { accountController } from './account.controller';

/**
 * Account lifecycle routes — all require authentication.
 *
 * GET    /account/export   — export all user data (JSON or ?format=csv)
 * DELETE /account          — permanently delete the account and all its data
 */
export async function accountRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  app.get('/account/export', accountController.exportAccount.bind(accountController));
  app.delete('/account', accountController.deleteAccount.bind(accountController));
}
