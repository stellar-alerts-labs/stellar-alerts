import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { auditController } from './audit.controller';

export async function auditRoutes(app: FastifyInstance) {
  app.register(async (authed) => {
    authed.addHook('preHandler', authenticateHook);
    authed.get('/audit/:id/proof', auditController.getProof.bind(auditController));
  });
}
