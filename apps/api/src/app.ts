import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './config/env';
import prismaPlugin from './plugins/prisma';
import metricsPlugin from './plugins/metrics';
import { authRoutes } from './modules/auth/auth.routes';
import { walletsRoutes } from './modules/wallets/wallets.routes';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes';
import { accountRoutes } from './modules/account/account.routes';
import { registerSecurityHeaders } from './middleware/security.middleware';
import { registerCorrelation } from './middleware/correlation.middleware';
import { registerIdempotency } from './middleware/idempotency.middleware';
import { sorobanStateRoutes } from './modules/soroban-state/soroban-state.routes';
import { notificationsRoutes } from './modules/notifications/notifications.routes';
import { alertRulesRoutes } from './modules/alert-rules/alert-rules.routes';
import { deadLettersRoutes } from './modules/dead-letters/dead-letters.routes';
import { txSimulationRoutes } from './modules/tx-simulation/tx-simulation.routes';
import { graphqlRoutes } from './modules/graphql/graphql.routes';
import { exportsRoutes } from './modules/exports/exports.routes';
import { openApiOptions } from './openapi.config';

import { checkRedisReadiness, getRedisStatus } from './lib/redis';
import { dbFailover } from './lib/db-failover';
import degradedModePlugin from './plugins/degraded-mode';
import { AppError } from './lib/errors';

export { openApiComponentSchemas, openApiOptions } from './openapi.config';

export const buildApp = async () => {
  const app = Fastify({
    logger: true,
    pluginTimeout: 30000,
    /**
     * Correlation ID strategy:
     *  1. Use the incoming `x-request-id` header value if provided by the client.
     *  2. Otherwise generate a fresh UUID v4 via the Node built-in crypto module.
     *
     * Fastify automatically binds the resolved ID to `request.id` and injects
     * it into every Pino log line produced via `request.log.*` as the `reqId`
     * field, giving full per-request traceability at zero extra cost.
     */
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const existing = req.headers['x-request-id'];
      if (existing) {
        // Accept the first value when the header is repeated
        return Array.isArray(existing) ? existing[0] : existing;
      }
      return crypto.randomUUID();
    },
  });

  /**
   * Echo the resolved correlation ID back to the caller on every response so
   * that clients and API gateways can cross-reference server-side log entries.
   */
  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.requestId || request.id);
  });

  // ── Security & observability hooks (registered before routes) ────────────
  await registerSecurityHeaders(app);
  await registerCorrelation(app);
  await registerIdempotency(app);
  /**
   * Central error envelope: every thrown AppError (see lib/errors.ts) and
   * any other unhandled error is serialized into one consistent shape —
   * { error: { code, message, details?, requestId } } — instead of each
   * controller hand-rolling its own ad-hoc response body. A message on an
   * unrecognized/unexpected error is never forwarded to the client (it
   * could contain internal detail, e.g. a raw Prisma/Postgres error); only
   * a generic INTERNAL_ERROR is sent, with the real error logged
   * server-side against the same requestId a client can report back.
   */
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, error.message);
      } else {
        request.log.warn({ err: error }, error.message);
      }
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
          requestId: request.requestId || request.id,
        },
      });
    }

    // Fastify's own schema-based request validation (route `schema.body`/etc.,
    // distinct from this codebase's usual manual Zod `safeParse` calls).
    if (Array.isArray((error as any).validation)) {
      request.log.warn({ err: error }, 'Request schema validation failed');
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: (error as any).validation,
          requestId: request.requestId || request.id,
        },
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: request.requestId || request.id,
      },
    });
  });

  await app.register(cors, {
    origin: true // Allow all origins for dev, or specify 'http://localhost:3000'
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  });

  await app.register(multipart, {
    limits: {
      // Per-file cap; the wasm-analyzer route additionally enforces
      // env.WASM_ANALYZER_MAX_UPLOAD_BYTES per request via request.file().
      fileSize: env.WASM_ANALYZER_MAX_UPLOAD_BYTES,
      files: 1,
    },
  });

  await app.register(swagger, openApiOptions);

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  await app.register(prismaPlugin);
  await app.register(metricsPlugin);
  await app.register(degradedModePlugin);

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/health/ready', async (request, reply) => {
    const redisHealth = await checkRedisReadiness();
    const database = await dbFailover.getStatus();
    const isReady = redisHealth.isReady;
    // Read-only mode still serves reads, so the pod stays in rotation; it is reported as degraded.
    const degraded = !isReady || database.state === 'DEGRADED_READ_ONLY';
    return reply.status(isReady ? 200 : 503).send({
      status: degraded ? 'degraded' : 'ready',
      redis: redisHealth,
      database,
    });
  });

  app.register(authRoutes);
  app.register(walletsRoutes);
  app.register(paymentsRoutes);
  app.register(webhooksRoutes);
  app.register(accountRoutes);
  app.register(notificationsRoutes);
  app.register(alertRulesRoutes);
  app.register(deadLettersRoutes);
  app.register(txSimulationRoutes);
  await app.register(graphqlRoutes);
  app.register(exportsRoutes);

  return app;
};
