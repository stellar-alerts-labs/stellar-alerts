import { FastifyInstance } from 'fastify';

import {
  discordInteractionsController,
  type RequestWithRawBody,
} from './discord-interactions.controller';
import { DISCORD_INTERACTIONS_PATH } from './discord-interactions.types';

/**
 * Discord requires the raw, unparsed request body for Ed25519 verification, so
 * this plugin registers a scoped JSON content-type parser that captures the
 * buffer before Fastify deserialises it. Fastify encapsulation keeps that
 * parser from affecting any other route.
 */
export async function discordInteractionsRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body as Buffer;
    (request as RequestWithRawBody).rawBody = raw;
    try {
      done(null, JSON.parse(raw.toString('utf8')));
    } catch {
      // Mirror Fastify's built-in JSON parser so a malformed body still answers
      // 400 `FST_ERR_CTP_INVALID_JSON_BODY` instead of surfacing as a 500.
      const parseError = new Error(
        "Body is not valid JSON but content-type is set to 'application/json'",
      ) as Error & { statusCode: number; code: string };
      parseError.statusCode = 400;
      parseError.code = 'FST_ERR_CTP_INVALID_JSON_BODY';
      done(parseError, undefined);
    }
  });

  app.post(
    DISCORD_INTERACTIONS_PATH,
    discordInteractionsController.handleInteraction.bind(discordInteractionsController),
  );
}
