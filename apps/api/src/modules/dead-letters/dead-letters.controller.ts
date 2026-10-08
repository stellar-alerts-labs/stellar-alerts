import { FastifyRequest, FastifyReply } from 'fastify';
import {
  deadLetterIdSchema,
  listDeadLettersQuerySchema,
  suppressDeadLetterSchema,
} from './dead-letters.schema';
import { deadLettersService } from './dead-letters.service';
import { CursorError } from '../../utils/pagination';
import { ConflictError, NotFoundError, ValidationError, zodValidationError } from '../../lib/errors';

export class DeadLettersController {
  async list(request: FastifyRequest, reply: FastifyReply) {
    const parsed = listDeadLettersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid query');
    }

    const userId = (request as any).user.id;
    try {
      const result = await deadLettersService.list(userId, parsed.data);
      return reply.send({ success: true, deadLetters: result.items, pagination: result.pagination });
    } catch (err) {
      if (err instanceof CursorError) {
        throw new ValidationError('Invalid cursor', [{ path: ['cursor'], message: (err as Error).message }]);
      }
      throw err;
    }
  }

  async get(request: FastifyRequest, reply: FastifyReply) {
    const parsed = deadLetterIdSchema.safeParse(request.params);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid parameters');
    }

    try {
      const userId = (request as any).user.id;
      const deadLetter = await deadLettersService.get(parsed.data.id, userId);
      return reply.send({ success: true, deadLetter });
    } catch (error: any) {
      if (error.message && error.message.startsWith('Dead letter')) {
        throw new NotFoundError(error.message);
      }
      throw error;
    }
  }

  async replay(request: FastifyRequest, reply: FastifyReply) {
    const parsed = deadLetterIdSchema.safeParse(request.params);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid parameters');
    }

    try {
      const userId = (request as any).user.id;
      const result = await deadLettersService.replay(parsed.data.id, userId);
      return reply.send({ success: result.success, message: result.message });
    } catch (error: any) {
      if (error.message.startsWith('Dead letter')) {
        throw new NotFoundError(error.message);
      }
      if (error.message.includes('Suppressed')) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  }

  async suppress(request: FastifyRequest, reply: FastifyReply) {
    const params = deadLetterIdSchema.safeParse(request.params);
    const body = suppressDeadLetterSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      throw new ValidationError('Invalid request', params.success ? body.error?.format() : params.error.format());
    }

    try {
      const userId = (request as any).user.id;
      const deadLetter = await deadLettersService.suppress(params.data.id, userId, body.data.note);
      return reply.send({ success: true, deadLetter });
    } catch (error: any) {
      if (error.message.startsWith('Dead letter')) {
        throw new NotFoundError(error.message);
      }
      if (error.message.includes('already suppressed')) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  }
}

export const deadLettersController = new DeadLettersController();