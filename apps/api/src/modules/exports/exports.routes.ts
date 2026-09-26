import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { exportsController } from './exports.controller';

export async function exportsRoutes(app: FastifyInstance) {
  // Owner-scoped job management; requires a bearer token.
  app.register(async (authed) => {
    authed.addHook('preHandler', authenticateHook);
    authed.post('/exports', exportsController.create.bind(exportsController));
    authed.get('/exports', exportsController.list.bind(exportsController));
    authed.get('/exports/:id', exportsController.get.bind(exportsController));
  });

  // Authorized by the signed link from GET /exports/:id, not a bearer token.
  app.get('/exports/:id/download', exportsController.download.bind(exportsController));
}
