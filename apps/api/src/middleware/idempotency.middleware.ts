/**
 * Idempotency keys for mutating endpoints (#334).
 *
 * Correlation IDs already exist (`x-request-id`, issue #44) and answer "which
 * log lines belong to this request". This module answers a different question:
 * "has this exact mutation already been applied?" A client that retries a
 * `POST /wallets` after a timeout, or a proxy that duplicates a request, must
 * not create two wallets.
 *
 * Protocol (follows the `Idempotency-Key` convention):
 *
 *   POST /wallets
 *   Idempotency-Key: 8f14e45f-ceea-467a-9d1b-2b2e2b1b0c9a
 *
 *   1. First request    -> the handler runs, the response is stored and returned.
 *   2. Retry, same key  -> the stored response is replayed; the handler does not run.
 *   3. Retry while the first is in flight -> 409, so the client retries later
 *      rather than double-applying.
 *   4. Same key, different body -> 422. Reusing a key for a different payload is
 *      a client bug, and replaying the first response would hide it.
 *
 * Requests without the header are untouched: opt-in is per request.
 *
 * Wiring: `preValidation` reserves the key and, on a replay, short-circuits the
 * request. `onSend` observes the response the handler produced. `onResponse`
 * commits or releases the reservation.
 *
 * The reservation deliberately runs in `preValidation` rather than `onRequest`:
 * Fastify parses the body between those two hooks, so `request.body` is
 * `undefined` in `onRequest` and a payload fingerprint computed there would be
 * the hash of nothing for every request — silently defeating the
 * "same key, different body" check.
 */

import { createHash } from 'crypto';
import type {
  FastifyReply,
  FastifyRequest,
  onResponseHookHandler,
  onSendHookHandler,
  preValidationHookHandler,
} from 'fastify';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const log = createLogger({ module: 'Idempotency' });

/** How long a completed key stays replayable. Matches common gateway defaults. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Header carrying the client's key. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Set on every non-replayed response so callers can confirm a fresh run. */
export const IDEMPOTENCY_REPLAY_HEADER = 'idempotency-replayed';

interface IdempotencyState {
  /** Row id of the reservation this request owns. */
  recordId: string;
}

export interface IdempotencyOptions {
  /** Override the retention window, mainly for tests. */
  ttlMs?: number;
  /**
   * Fields excluded from the request fingerprint. Useful when the body carries
   * a per-attempt value that a legitimate retry is expected to change.
   */
  ignoredBodyFields?: string[];
}

/** Deterministic hash of the request payload, used to detect key reuse. */
export function fingerprintRequest(
  request: FastifyRequest,
  ignoredBodyFields: string[] = [],
): string {
  const body = request.body;
  let serialised: string;

  if (body === undefined || body === null) {
    serialised = '';
  } else if (typeof body === 'string') {
    serialised = body;
  } else if (typeof body === 'object') {
    const entries = Object.entries(body as Record<string, unknown>)
      .filter(([k]) => !ignoredBodyFields.includes(k))
      // Sort so JSON key order does not change the fingerprint.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    serialised = JSON.stringify(entries);
  } else {
    serialised = String(body);
  }

  return createHash('sha256').update(serialised).digest('hex');
}

/**
 * Route scope: the same key on two endpoints must stay independent, and a key
 * reused across two different routes is not a retry of either.
 */
export function scopeFor(request: FastifyRequest): string {
  const route = request.routeOptions?.url ?? request.url.split('?')[0];
  return `${request.method.toUpperCase()} ${route}`;
}

function normaliseKey(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    return raw.length === 1 ? raw[0] : undefined;
  }
  return typeof raw === 'string' ? raw : undefined;
}

/** Prisma raises P2002 for a unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

/**
 * The three hooks that implement the protocol, in the order Fastify runs them.
 */
export function idempotencyHooks(options: IdempotencyOptions = {}): {
  preValidation: preValidationHookHandler;
  onSend: onSendHookHandler;
  onResponse: onResponseHookHandler;
} {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const ignored = options.ignoredBodyFields ?? [];
  const state = new WeakMap<FastifyRequest, IdempotencyState>();
  const captured = new WeakMap<FastifyRequest, { statusCode: number; payload: unknown }>();

  const preValidation: preValidationHookHandler = async (request, reply) => {
    const key = normaliseKey(request.headers[IDEMPOTENCY_HEADER]);

    // Opt-in: no header means no behaviour change.
    if (!key) {
      return;
    }

    const scope = scopeFor(request);
    const requestHash = fingerprintRequest(request, ignored);
    const userId =
      (request as FastifyRequest & { user?: { id?: string } }).user?.id ?? null;

    // ── Reserve the key ────────────────────────────────────────────────────
    let reserved: { id: string };
    try {
      reserved = await prisma.idempotencyKey.create({
        data: {
          key,
          scope,
          userId,
          requestHash,
          status: 'in_progress',
          expiresAt: new Date(Date.now() + ttlMs),
        },
        select: { id: true },
      });
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // The key already exists: a completed request, or one still in flight.
      const existing = await prisma.idempotencyKey.findUnique({
        where: { key_scope: { key, scope } },
        select: { status: true, statusCode: true, response: true, requestHash: true },
      });

      if (!existing) {
        // Reaped between the failed insert and this read. Let it run as fresh.
        return;
      }

      // Same key, different payload: a client bug, not a retry.
      if (existing.requestHash !== requestHash) {
        return reply.status(422).send({
          error: 'Idempotency Key Reused',
          message: 'This Idempotency-Key was already used with a different request body.',
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }

      if (existing.status === 'in_progress') {
        // A concurrent duplicate. Do not run the handler again.
        return reply.status(409).send({
          error: 'Conflict',
          message:
            'A request with this Idempotency-Key is already in progress. Retry shortly.',
          code: 'IDEMPOTENCY_IN_PROGRESS',
        });
      }

      // Completed: replay the stored response verbatim.
      reply.header(IDEMPOTENCY_REPLAY_HEADER, 'true');
      const body = existing.response ? JSON.parse(existing.response) : null;
      return reply.status(existing.statusCode ?? 200).send(body);
    }

    state.set(request, { recordId: reserved.id });
    reply.header(IDEMPOTENCY_REPLAY_HEADER, 'false');
  };

  // Runs after the handler produced its response, before it is written to the
  // socket. The payload here is the serialised string the client will receive.
  const onSend: onSendHookHandler = async (request, reply, payload) => {
    if (state.has(request)) {
      captured.set(request, { statusCode: reply.statusCode, payload });
    }
    return payload;
  };

  const onResponse: onResponseHookHandler = async (request, reply) => {
    const held = state.get(request);
    if (!held) {
      return;
    }
    state.delete(request);

    const seen = captured.get(request);
    const statusCode = seen?.statusCode ?? reply.statusCode;

    try {
      if (statusCode >= 500) {
        // A server error is not a result: release the reservation so the
        // client's retry re-runs the handler instead of replaying a 500.
        await prisma.idempotencyKey.delete({ where: { id: held.recordId } });
        return;
      }

      await prisma.idempotencyKey.update({
        where: { id: held.recordId },
        data: {
          status: 'completed',
          statusCode,
          response: JSON.stringify(seen?.payload ?? null),
        },
      });
    } catch (error: unknown) {
      // Never fail a request the client already received because bookkeeping
      // failed. The worst case is a retry that re-runs the handler.
      log.warn(
        { err: (error as Error).message, requestId: request.id },
        'Failed to persist idempotency outcome',
      );
    }
  };

  return { preValidation, onSend, onResponse };
}

/**
 * Delete keys past their retention window. Intended for the scheduler; each
 * run is bounded so it cannot hold a long transaction.
 */
export async function reapExpiredIdempotencyKeys(batchSize = 1000): Promise<number> {
  const expired = await prisma.idempotencyKey.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { id: true },
    take: batchSize,
  });

  if (expired.length === 0) {
    return 0;
  }

  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { id: { in: expired.map((row: { id: string }) => row.id) } },
  });

  return count;
}
