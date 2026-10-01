import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { env } from '../../config/env';
import { txSimulationController } from './tx-simulation.controller';

export async function txSimulationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  app.post(
    '/tx-simulation/analyze',
    // Tighter than the global limiter: decoding XDR and persisting an audit
    // row is real work per request, and this is an endpoint a client may call
    // in a tight loop over candidate envelopes.
    { config: { rateLimit: { max: env.TX_SIMULATION_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    txSimulationController.analyze.bind(txSimulationController),
  );
}
