import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';

/**
 * Request correlation — ensures every request and its response carry a stable
 * `X-Request-ID` header that can be used to trace a single transaction across
 * logs, downstream services, and client error reports.
 *
 * Behaviour:
 *  - If the incoming request already has an `X-Request-ID` header that is a
 *    valid UUID (≤128 chars, no newlines) it is accepted and propagated.
 *  - Otherwise a fresh UUID v4 is generated server-side.
 *  - The resolved ID is attached to `request.requestId`, echoed in the
 *    response header, and bound to the Fastify request logger so every log
 *    line emitted during the request lifecycle includes `requestId`.
 */

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
// Reject header values that look like injection attempts or are unreasonably long.
const SAFE_ID_RE = /^[\w\-]{1,128}$/;

export async function registerCorrelation(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => {
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

    // Bind the id to the child logger so it appears in every log line for
    // this request without callers having to pass it explicitly.
    // Fastify 5 exposes `request.log` as a child logger — rebind it.
    (request as any).log = request.log.child({ requestId: id });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    // Echo the resolved request ID back so clients can correlate with their
    // own logs.
    reply.header(REQUEST_ID_HEADER, request.requestId || request.id);
    return payload;
  });
}
