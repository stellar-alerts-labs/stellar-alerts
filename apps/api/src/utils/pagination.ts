/**
 * Opaque cursor pagination utility — Issue #318
 *
 * Design goals:
 *  - Opaque cursors: clients treat them as black boxes (base64-encoded JSON internally).
 *  - Stable ordering: every collection is ordered by (createdAt DESC, id DESC) so
 *    records inserted between pages never shift existing pages.
 *  - Consistent limit bounds: 1–100, default 20.
 *  - Invalid-cursor behaviour: throws a typed CursorError that controllers map to 400.
 *  - Zero schema migrations: cursors encode values already present on every model.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Limit schema — reused across all paginated routes
// ---------------------------------------------------------------------------

export const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .default(20);

// ---------------------------------------------------------------------------
// Cursor schema — optional opaque string accepted in query params
// ---------------------------------------------------------------------------

export const cursorSchema = z.string().optional();

// ---------------------------------------------------------------------------
// Shared query schema fragment for cursor-paginated lists
// ---------------------------------------------------------------------------

export const cursorPaginationQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
});

export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;

// ---------------------------------------------------------------------------
// Internal cursor payload
// ---------------------------------------------------------------------------

interface CursorPayload {
  /** ISO-8601 timestamp of the last record returned */
  createdAt: string;
  /** CUID of the last record returned (tie-breaker) */
  id: string;
}

// ---------------------------------------------------------------------------
// Error type for invalid cursors
// ---------------------------------------------------------------------------

export class CursorError extends Error {
  constructor(message = 'Invalid or expired cursor') {
    super(message);
    this.name = 'CursorError';
  }
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * Encodes a cursor from the last item of a page. Returns undefined when
 * the page is empty.
 */
export function encodeCursor(item: { id: string; createdAt: Date }): string {
  const payload: CursorPayload = {
    createdAt: item.createdAt.toISOString(),
    id: item.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes an opaque cursor string back to its payload.
 * Throws {@link CursorError} if the cursor is malformed.
 */
export function decodeCursor(cursor: string): CursorPayload {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new CursorError();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new CursorError();
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as any).createdAt !== 'string' ||
    typeof (payload as any).id !== 'string' ||
    isNaN(Date.parse((payload as any).createdAt))
  ) {
    throw new CursorError();
  }

  return payload as CursorPayload;
}

// ---------------------------------------------------------------------------
// Prisma where-clause builder
// ---------------------------------------------------------------------------

/**
 * Builds the Prisma `where` fragment that implements the cursor condition.
 *
 * Stable ordering: `(createdAt DESC, id DESC)` means "earlier than the
 * cursor record" is expressed as:
 *
 *   createdAt < cursor.createdAt
 *   OR (createdAt = cursor.createdAt AND id < cursor.id)
 *
 * Only call this when a cursor is present; otherwise omit the fragment
 * entirely so the first page is returned.
 */
export function buildCursorWhere(cursor: string): object {
  const { createdAt, id } = decodeCursor(cursor);
  return {
    OR: [
      { createdAt: { lt: new Date(createdAt) } },
      { createdAt: new Date(createdAt), id: { lt: id } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Standard orderBy for cursor-paginated queries
// ---------------------------------------------------------------------------

/** Use this as the `orderBy` for every cursor-paginated collection. */
export const CURSOR_ORDER_BY = [
  { createdAt: 'desc' as const },
  { id: 'desc' as const },
] as const;

// ---------------------------------------------------------------------------
// Response envelope builder
// ---------------------------------------------------------------------------

/**
 * Wraps a page of items in the standard pagination envelope:
 *
 * ```json
 * {
 *   "items": [...],
 *   "pagination": {
 *     "limit": 20,
 *     "nextCursor": "<opaque>",   // present only when a next page exists
 *     "hasNextPage": true
 *   }
 * }
 * ```
 *
 * Convention: fetch `limit + 1` rows from Prisma, pass them all here.
 * This function slices off the extra row and uses it only to compute
 * `nextCursor`, so clients never see it.
 */
export function buildCursorPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
): {
  items: T[];
  pagination: { limit: number; nextCursor?: string; hasNextPage: boolean };
} {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasNextPage && items.length > 0
      ? encodeCursor(items[items.length - 1])
      : undefined;

  return {
    items,
    pagination: { limit, nextCursor, hasNextPage },
  };
}
