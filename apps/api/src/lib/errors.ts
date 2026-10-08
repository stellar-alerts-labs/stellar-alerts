/**
 * Shared error envelope for the API.
 *
 * Before this, every controller hand-rolled its own ad-hoc error shape
 * inline (`{ error: 'Invalid query', details }`, `{ error: 'Unauthorized',
 * message }`, `{ error: 'Not Found', message }`, ...) with no consistency
 * across routes and no central place enforcing that a client-facing
 * message never leaks internal detail. AppError (and its subclasses below)
 * plus app.ts's `setErrorHandler` replace that: a controller throws one of
 * these, and the error handler serializes it into one envelope shape:
 *
 *   { error: { code, message, details?, requestId } }
 *
 * `code` is a stable, machine-readable string a client can branch on
 * without parsing `message`. `message` must always be safe to show a
 * client — never a raw Prisma/Postgres error, stack trace, or other
 * internal detail. `requestId` echoes the same correlation id already
 * attached to every response via the `x-request-id` header (see app.ts),
 * so a client-reported error can be cross-referenced against server logs.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** 400 — the request body/query/params failed schema or business-rule validation. */
export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: unknown, code = 'VALIDATION_ERROR') {
    super(400, code, message, details);
  }
}

/** 401 — the caller isn't authenticated, or their credentials/token are invalid or expired. */
export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    super(401, code, message);
  }
}

/** 403 — the caller is authenticated but not allowed to perform this action. */
export class AuthorizationError extends AppError {
  constructor(message = 'Forbidden', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

/** 404 — the requested resource doesn't exist, or doesn't belong to the caller. */
export class NotFoundError extends AppError {
  constructor(message = 'Not found', code = 'NOT_FOUND') {
    super(404, code, message);
  }
}

/** 409 — the request conflicts with the resource's current state (duplicate, already-suppressed, etc). */
export class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT') {
    super(409, code, message);
  }
}

/** 429 — the caller has exceeded a rate limit specific to this operation (distinct from the global @fastify/rate-limit plugin). */
export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', code = 'RATE_LIMITED') {
    super(429, code, message);
  }
}

/** 502 by default — an upstream dependency (Horizon, a webhook endpoint, a notification channel) failed or returned an unusable response. */
export class ProviderError extends AppError {
  constructor(message = 'Upstream provider error', code = 'PROVIDER_ERROR', statusCode = 502) {
    super(statusCode, code, message);
  }
}

/**
 * Converts a Zod `safeParse` failure into a ValidationError carrying its
 * field-level `.format()` output as `details` — the same shape controllers
 * already sent ad-hoc, now behind one helper.
 */
export function zodValidationError(
  result: { success: false; error: { format(): unknown } },
  message = 'Invalid request',
): ValidationError {
  return new ValidationError(message, result.error.format());
}
