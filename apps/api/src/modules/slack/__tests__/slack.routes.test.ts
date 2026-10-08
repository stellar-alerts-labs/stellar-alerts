import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import crypto from 'node:crypto';
import { slackRoutes } from '../slack.routes';
import { slackCommandService } from '../slack.service';
import { env } from '../../../config/env';

vi.mock('../../../config/env', () => ({
  env: { SLACK_SIGNING_SECRET: 'test-slack-signing-secret' as string | undefined },
}));

vi.mock('../slack.service', () => ({
  slackCommandService: {
    handleCommand: vi.fn().mockResolvedValue({ response_type: 'ephemeral', text: 'ok' }),
  },
}));

const SECRET = () => env.SLACK_SIGNING_SECRET as string;

function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1000).toString()) {
  const base = `v0:${timestamp}:${body}`;
  const signature = `v0=${crypto.createHmac('sha256', SECRET()).update(base).digest('hex')}`;
  return {
    'content-type': 'application/x-www-form-urlencoded',
    'x-slack-signature': signature,
    'x-slack-request-timestamp': timestamp,
  };
}

const COMMAND_BODY = 'command=%2Fstellar&text=balance&user_id=U123&user_name=tester';

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(slackRoutes);
  await app.ready();
  return app;
}

describe('POST /slack/commands', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const originalSecret = env.SLACK_SIGNING_SECRET;

  beforeEach(async () => {
    vi.clearAllMocks();
    env.SLACK_SIGNING_SECRET = originalSecret;
    app = await buildTestApp();
  });

  afterEach(async () => {
    env.SLACK_SIGNING_SECRET = originalSecret;
    await app.close();
  });

  it('responds 200 with an ephemeral payload for a valid signed command', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/slack/commands',
      headers: signedHeaders(COMMAND_BODY),
      payload: COMMAND_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ response_type: 'ephemeral', text: 'ok' });
    expect(slackCommandService.handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/stellar',
        text: 'balance',
        user_id: 'U123',
        user_name: 'tester',
      }),
    );
  });

  it('rejects a request with no signature header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/slack/commands',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': Math.floor(Date.now() / 1000).toString(),
      },
      payload: COMMAND_BODY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'missing_signature' });
    expect(slackCommandService.handleCommand).not.toHaveBeenCalled();
  });

  it('rejects a request whose body was tampered with after signing', async () => {
    const headers = signedHeaders(COMMAND_BODY);
    const tampered = COMMAND_BODY.replace('balance', 'alerts');

    const response = await app.inject({
      method: 'POST',
      url: '/slack/commands',
      headers,
      payload: tampered,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'invalid_signature' });
  });

  it('rejects replayed requests with a stale timestamp', async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000 - 400).toString();
    const headers = signedHeaders(COMMAND_BODY, staleTimestamp);

    const response = await app.inject({
      method: 'POST',
      url: '/slack/commands',
      headers,
      payload: COMMAND_BODY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'stale_timestamp' });
  });

  it('rejects malformed command payloads with 400', async () => {
    const malformedBody = 'command=%2Fstellar';

    const response = await app.inject({
      method: 'POST',
      url: '/slack/commands',
      headers: signedHeaders(malformedBody),
      payload: malformedBody,
    });

    expect(response.statusCode).toBe(400);
    expect(slackCommandService.handleCommand).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the signing secret is not configured', async () => {
    env.SLACK_SIGNING_SECRET = undefined;

    const response = await app.inject({
      method: 'POST',
      url: '/slack/commands',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-signature': 'v0=abc',
        'x-slack-request-timestamp': Math.floor(Date.now() / 1000).toString(),
      },
      payload: COMMAND_BODY,
    });

    expect(response.statusCode).toBe(503);
    expect(slackCommandService.handleCommand).not.toHaveBeenCalled();
  });
});
