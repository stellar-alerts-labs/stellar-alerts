import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import prismaPlugin from './plugins/prisma';
import { registerSSEPushPlugin } from './plugins/websocket';
import { prisma } from './lib/prisma';
import { alertQueue } from './lib/queue';
import { sorobanServer } from './lib/soroban';
import { authRoutes } from './modules/auth/auth.routes';
import { walletsRoutes } from './modules/wallets/wallets.routes';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes';
import { requestLinkSchema, verifyLinkSchema } from './modules/auth/auth.schema';
import { createWalletSchema } from './modules/wallets/wallets.schema';
import { createWebhookSchema } from './modules/webhooks/webhooks.schema';

const openApiComponentSchemas = {
  RequestLinkInput: z.toJSONSchema(requestLinkSchema),
  VerifyLinkInput: z.toJSONSchema(verifyLinkSchema),
  CreateWalletInput: z.toJSONSchema(createWalletSchema),
  CreateWebhookInput: z.toJSONSchema(createWebhookSchema),
};

export const buildApp = async () => {
  // Issue #19: Correlation IDs — read x-request-id header or generate a UUID
  const app = Fastify({
    logger: true,
    pluginTimeout: 30000,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (incoming) {
        return Array.isArray(incoming) ? incoming[0] : incoming;
      }
      return randomUUID();
    },
  });

  await app.register(cors, {
    origin: true // Allow all origins for dev, or specify 'http://localhost:3000'
  });

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Stellar Alerts API',
        description:
          'Interactive API documentation for the Stellar Payment Tracker. Register wallets, monitor payments and manage webhook alert endpoints.',
        version: '1.0.0',
      },
      tags: [
        { name: 'auth', description: 'Magic-link authentication' },
        { name: 'wallets', description: 'Watched Stellar wallet management' },
        { name: 'payments', description: 'Incoming payment history and summaries' },
        { name: 'webhooks', description: 'Custom webhook alert endpoint management' },
      ],
      components: {
        schemas: openApiComponentSchemas as Record<string, any>,
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  await app.register(prismaPlugin);

  // Issue #64: SSE push endpoint — GET /events
  await app.register(registerSSEPushPlugin);

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Issue #18: Deep Health Inspection Probe — no authentication required
  app.get('/health/deep', async (_req, reply) => {
    const checks: { postgres: 'ok' | 'error'; redis: 'ok' | 'error'; horizon: 'ok' | 'error' } = {
      postgres: 'error',
      redis: 'error',
      horizon: 'error',
    };

    // PostgreSQL ping
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch {
      // leave as 'error'
    }

    // Redis ping via BullMQ queue's underlying ioredis client
    try {
      if (alertQueue && alertQueue.client) {
        await alertQueue.client.ping();
        checks.redis = 'ok';
      }
    } catch {
      // leave as 'error'
    }

    // Horizon / Soroban RPC ping
    try {
      await sorobanServer.getLatestLedger();
      checks.horizon = 'ok';
    } catch {
      // leave as 'error'
    }

    const allOk = checks.postgres === 'ok' && checks.redis === 'ok' && checks.horizon === 'ok';
    const status = allOk ? 'ok' : 'degraded';
    const statusCode = allOk ? 200 : 503;

    return reply.code(statusCode).send({ status, checks });
  });

  app.register(authRoutes);
  app.register(walletsRoutes);
  app.register(paymentsRoutes);
  app.register(webhooksRoutes);

  return app;
};
