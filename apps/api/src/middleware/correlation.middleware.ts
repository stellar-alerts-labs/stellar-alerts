import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { correlationContext } from '../lib/correlation-context';

/**
 * Request correlation — ensures every request and its response carry a stable
 * `X-Request-ID` header that can be used to trace a single transaction across
 * logs, downstream services, and client error reports.
 */

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    reqId: string;
  }
}

export const REQUEST_ID_HEADER = 'x-request-id';
// Reject header values that look like injection attempts or are unreasonably long.
const SAFE_ID_RE = /^[\w\-]{1,128}$/;

export async function registerCorrelation(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', (request, _reply, done) => {
    const incoming = request.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

    const id =
      candidate && SAFE_ID_RE.test(candidate)
        ? candidate
        : request.id && SAFE_ID_RE.test(request.id) && request.id.includes('-')
          ? request.id
          : randomUUID();

    request.id = id;
    request.requestId = id;
    request.reqId = id;

    // Bind both reqId and requestId to the child logger
    (request as any).log = request.log.child({ reqId: id, requestId: id });

    // Enter AsyncLocalStorage scope for downstream requests & logging
    correlationContext.run({ requestId: id }, done);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header(REQUEST_ID_HEADER, request.requestId || request.reqId || request.id);
    return payload;
  });
}
