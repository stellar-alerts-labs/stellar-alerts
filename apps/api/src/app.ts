import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import prismaPlugin from './plugins/prisma';
import { env } from './config/env';
import { createOriginValidator, parseAllowedOrigins } from './config/cors';
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
  const app = Fastify({
    logger: true,
    pluginTimeout: 30000,
  });

  const allowedOrigins = parseAllowedOrigins(env.APP_URL);
  app.log.info(`🔒 CORS whitelist: ${allowedOrigins.join(', ') || '(none)'}`);

  await app.register(cors, {
    origin: createOriginValidator(allowedOrigins),
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // Cache the preflight result for a day so browsers stop re-asking
    maxAge: 86400,
  });

  await app.register(helmet, {
    // The API answers with JSON everywhere except the Swagger UI, which ships
    // its own CSP via staticCSP below.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: {
      maxAge: 15552000,
      includeSubDomains: true,
    },
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
        schemas: openApiComponentSchemas,
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    // Emits a CSP covering Swagger UI's own inline assets, replacing the strict
    // API policy on the documentation routes only.
    staticCSP: true,
  });

  await app.register(prismaPlugin);

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.register(authRoutes);
  app.register(walletsRoutes);
  app.register(paymentsRoutes);
  app.register(webhooksRoutes);

  return app;
};
