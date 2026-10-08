import { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../../lib/errors';
import { analyzeSimulationSchema, listSimulationsQuerySchema, simulationIdSchema } from './simulation.schema';
import { simulationService } from './simulation.service';

function sendSimulationError(reply: FastifyReply, error: unknown) {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export class SimulationController {
  /**
   * POST /simulations/analyze
   *
   * Returns 201 with the persisted assessment rather than 200: a simulation is a
   * durable audit record, so the caller gets an id to attach to their review.
   */
  async analyze(request: FastifyRequest, reply: FastifyReply) {
    const parsed = analyzeSimulationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parsed.error.format() });
    }

    try {
      const userId = (request as any).user.id;
      const simulation = await simulationService.analyze(userId, parsed.data);
      return reply.status(201).header('Location', `/simulations/${simulation.id}`).send({ success: true, simulation });
    } catch (error) {
      return sendSimulationError(reply, error);
    }
  }

  async list(request: FastifyRequest, reply: FastifyReply) {
    const parsed = listSimulationsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.format() });
    }

    const userId = (request as any).user.id;
    const result = await simulationService.list(userId, parsed.data);
    return reply.send({ success: true, ...result });
  }

  async get(request: FastifyRequest, reply: FastifyReply) {
    const parsed = simulationIdSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid parameters', details: parsed.error.format() });
    }

    try {
      const userId = (request as any).user.id;
      const simulation = await simulationService.get(userId, parsed.data.id);
      // Assessments are security decisions; never let a proxy cache one.
      return reply.header('Cache-Control', 'no-store').send({ success: true, simulation });
    } catch (error) {
      return sendSimulationError(reply, error);
    }
  }
}

export const simulationController = new SimulationController();