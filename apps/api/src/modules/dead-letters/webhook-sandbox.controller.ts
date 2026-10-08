import { FastifyRequest, FastifyReply } from 'fastify';
import {
  deadLetterIdSchema,
  sandboxReplayIdSchema,
  sandboxReplayInputSchema,
  listSandboxReplaysQuerySchema,
} from './dead-letters.schema';
import { webhookSandboxService } from './webhook-sandbox.service';

/**
 * Controllers for the webhook dead-letter sandbox replay inspector (#456).
 *
 * POST   /dead-letters/:id/replay-sandbox        → replay against the mock receiver
 * GET    /dead-letters/sandbox-replays           → list past sandbox inspections
 * GET    /dead-letters/sandbox-replays/:replayId → one inspection
 */
export class WebhookSandboxController {
  async replaySandbox(request: FastifyRequest, reply: FastifyReply) {
    const params = deadLetterIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'Invalid parameters', details: params.error.format() });
    }

    const body = sandboxReplayInputSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid mock response', details: body.error.format() });
    }

    try {
      const userId = (request as any).user.id;
      const result = await webhookSandboxService.replaySandbox(params.data.id, userId, {
        status: body.data.mockStatusCode,
        body: body.data.mockResponseBody ?? '',
        headers: body.data.mockResponseHeaders ?? {},
        delayMs: 0,
      });
      return reply.send({ ...result });
    } catch (error: any) {
      if (error.message.startsWith('Dead letter')) {
        return reply.status(404).send({ error: 'Not Found', message: error.message });
      }
      throw error;
    }
  }

  async listReplays(request: FastifyRequest, reply: FastifyReply) {
    const parsed = listSandboxReplaysQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.format() });
    }

    const userId = (request as any).user.id;
    const result = await webhookSandboxService.listReplays(userId, {
      page: 1,
      pageSize: parsed.data.limit ?? 20,
    });
    return reply.send({ success: true, ...result });
  }

  async getReplay(request: FastifyRequest, reply: FastifyReply) {
    const parsed = sandboxReplayIdSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid parameters', details: parsed.error.format() });
    }

    try {
      const userId = (request as any).user.id;
      const replay = await webhookSandboxService.getReplay(parsed.data.replayId, userId);
      return reply.send({ success: true, replay });
    } catch (error: any) {
      if (error.message.startsWith('Sandbox replay')) {
        return reply.status(404).send({ error: 'Not Found', message: error.message });
      }
      throw error;
    }
  }
}

export const webhookSandboxController = new WebhookSandboxController();
