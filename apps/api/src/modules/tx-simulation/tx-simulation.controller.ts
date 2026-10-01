import { FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError } from '../../lib/errors';
import { analyzeTransactionSchema } from './tx-simulation.schema';
import { txSimulationService } from './tx-simulation.service';

export class TxSimulationController {
  async analyze(request: FastifyRequest, reply: FastifyReply) {
    const parsed = analyzeTransactionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', parsed.error.format(), 'VALIDATION_ERROR');
    }

    // The route is behind authenticateHook, so `user` is always set; the
    // explicit guard keeps the service's contract (userId: string) honest
    // rather than relying on a non-null assertion.
    const userId = request.user?.id;
    if (!userId) {
      throw new ValidationError('Missing authenticated user context', undefined, 'AUTH_CONTEXT_MISSING');
    }

    const result = await txSimulationService.analyze(parsed.data, userId);

    return reply.status(200).send({ success: true, ...result });
  }
}

export const txSimulationController = new TxSimulationController();
