import { FastifyReply, FastifyRequest } from 'fastify';

import { env } from '../../config/env';
import { discordInteractionSchema } from './discord-interactions.schema';
import { discordInteractionsService } from './discord-interactions.service';
import { verifyDiscordRequest } from './discord-interactions.signature';
import type { DiscordInteractionPayload } from './discord-interactions.types';

/** Fastify request augmented with the raw body captured by the route parser. */
export interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export class DiscordInteractionsController {
  async handleInteraction(request: FastifyRequest, reply: FastifyReply) {
    const publicKeyHex = env.DISCORD_PUBLIC_KEY;
    if (!publicKeyHex) {
      return reply.status(503).send({ error: 'Discord interactions are not configured' });
    }

    const signatureHex = headerValue(request.headers['x-signature-ed25519']);
    const timestamp = headerValue(request.headers['x-signature-timestamp']);
    const rawBody = (request as RequestWithRawBody).rawBody;

    const verification = verifyDiscordRequest({
      publicKeyHex,
      signatureHex: signatureHex ?? '',
      timestamp: timestamp ?? '',
      body: rawBody ?? Buffer.from(''),
    });
    if (!verification.ok) {
      request.log.warn({ reason: verification.reason }, '[discord] interaction signature rejected');
      return reply.status(401).send({ error: 'Invalid request signature', reason: verification.reason });
    }

    const parsed = discordInteractionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid interaction payload', details: parsed.error.format() });
    }

    const response = await discordInteractionsService.handle(parsed.data as DiscordInteractionPayload);
    return reply.send(response);
  }
}

export const discordInteractionsController = new DiscordInteractionsController();
