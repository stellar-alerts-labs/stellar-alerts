import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env';
import { verifySlackSignature } from './slack.signature';
import { slackCommandPayloadSchema } from './slack.schema';
import { slackCommandService } from './slack.service';

export class SlackController {
  /**
   * Handles `/stellar` slash command invocations. Slack signs the exact raw
   * body it posts, so verification runs on the raw urlencoded string before
   * it is parsed into fields. Replies are ephemeral and sent synchronously
   * (HTTP 200 with JSON), well inside Slack's 3-second cutoff.
   */
  async handleCommand(request: FastifyRequest, reply: FastifyReply) {
    const rawBody = typeof request.body === 'string' ? request.body : '';

    const verification = verifySlackSignature(
      rawBody,
      request.headers['x-slack-signature'],
      request.headers['x-slack-request-timestamp'],
      env.SLACK_SIGNING_SECRET,
    );

    if (!verification.valid) {
      if (verification.failure === 'signing_secret_not_configured') {
        return reply.status(503).send({ error: 'Slack signing secret is not configured' });
      }
      return reply
        .status(401)
        .send({ error: 'Invalid Slack request signature', reason: verification.failure });
    }

    const parsed = slackCommandPayloadSchema.safeParse(
      Object.fromEntries(new URLSearchParams(rawBody)),
    );
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Malformed Slack command payload' });
    }

    const response = await slackCommandService.handleCommand(parsed.data);
    return reply.send(response);
  }
}

export const slackController = new SlackController();
