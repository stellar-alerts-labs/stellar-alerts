import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { simulationController } from './simulation.controller';

export async function simulationRoutes(app: FastifyInstance) {
  // Owner-scoped simulation history; every route requires a bearer token so a
  // threat assessment of a user's wallet is never public.
  app.register(async (authed) => {
    authed.addHook('preHandler', authenticateHook);
    authed.post(
      '/simulations/analyze',
      // Tighter than the global limit: analysis is CPU work over up to 1000
      // operations plus a write per call, so it gets its own per-client budget
      // on top of the app-wide limiter.
      {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
        schema: { tags: ['simulations'], summary: 'Analyze a transaction envelope', description: 'Pre-executes a Soroban transaction envelope and returns an explainable threat score with drain-detection analysis.' },
      },
      simulationController.analyze.bind(simulationController),
    );
    authed.get('/simulations', { schema: { tags: ['simulations'], summary: 'List simulation results', description: 'Returns paginated simulation analysis history for the authenticated user.' } }, simulationController.list.bind(simulationController));
    authed.get('/simulations/:id', { schema: { tags: ['simulations'], summary: 'Get a simulation result', description: 'Returns the full analysis result for a single simulation.' } }, simulationController.get.bind(simulationController));
  });
}