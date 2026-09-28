import { FastifyInstance } from 'fastify';
import { slackController } from './slack.controller';

export async function slackRoutes(app: FastifyInstance) {
  // Slack posts slash commands as application/x-www-form-urlencoded, which
  // Fastify does not parse by default. Keeping the parser scoped to this
  // plugin leaves every other route on the default JSON/text parsers, and
  // passing the raw string through lets the controller verify the Slack
  // HMAC signature against the exact bytes Slack sent.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, typeof body === 'string' ? body : String(body));
  });

  app.post('/slack/commands', slackController.handleCommand.bind(slackController));
}
