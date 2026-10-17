import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { exportsController } from './exports.controller';

export async function exportsRoutes(app: FastifyInstance) {
  // Owner-scoped job management; requires a bearer token.
  app.register(async (authed) => {
    authed.addHook('preHandler', authenticateHook);
    authed.post('/exports', { schema: { tags: ['exports'], summary: 'Create an export job', description: 'Queues an asynchronous CSV or PDF export of the user\'s payment history.' } }, exportsController.create.bind(exportsController));
    authed.get('/exports', { schema: { tags: ['exports'], summary: 'List export jobs', description: 'Returns all export jobs for the authenticated user with status and progress.' } }, exportsController.list.bind(exportsController));
    authed.get('/exports/:id', { schema: { tags: ['exports'], summary: 'Get an export job', description: 'Returns metadata and a signed download URL for a completed export.' } }, exportsController.get.bind(exportsController));
  });

  // Authorized by the signed link from GET /exports/:id, not a bearer token.
  app.get('/exports/:id/download', { schema: { tags: ['exports'], summary: 'Download export file', description: 'Streams the completed export file. Authorized by a signed link, not a bearer token.' } }, exportsController.download.bind(exportsController));
}
