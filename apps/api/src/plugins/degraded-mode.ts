import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { dbFailover } from '../lib/db-failover';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRY_AFTER_SECONDS = 15;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Routes that must keep working while the primary database is down (e.g. auth-free read-like POSTs). */
    allowInDegradedMode?: boolean;
  }
}

/**
 * Read-only degraded mode: while the primary database is partitioned, every
 * state-changing request is rejected with 503 + Retry-After and all responses
 * carry an `x-degraded-mode` header so clients can adapt.
 */
export default fp(async (server: FastifyInstance) => {
  server.addHook('onRequest', async (request, reply) => {
    if (!dbFailover.isReadOnly()) return;

    void reply.header('x-degraded-mode', 'read-only');

    if (SAFE_METHODS.has(request.method) || request.routeOptions?.config?.allowInDegradedMode) return;

    return reply
      .status(503)
      .header('retry-after', String(RETRY_AFTER_SECONDS))
      .send({
        error: 'Service Unavailable',
        code: 'READ_ONLY_DEGRADED_MODE',
        message: 'The primary database is unavailable. The API is temporarily read-only.',
      });
  });

  server.addHook('onReady', async () => {
    dbFailover.start();
  });

  server.addHook('onClose', async () => {
    dbFailover.stop();
  });
});
