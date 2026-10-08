import { describe, it, expect } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
  buildCursorWhere,
  buildCursorPage,
  CursorError,
  cursorPaginationQuerySchema,
  limitSchema,
} from '../pagination';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(id: string, createdAt: Date) {
  return { id, createdAt };
}

// ---------------------------------------------------------------------------
// encodeCursor / decodeCursor — round-trip
// ---------------------------------------------------------------------------

describe('encodeCursor / decodeCursor', () => {
  it('round-trips an item back to the same values', () => {
    const item = makeItem('clxyz123', new Date('2026-09-01T12:00:00.000Z'));
    const cursor = encodeCursor(item);
    const decoded = decodeCursor(cursor);

    expect(decoded.id).toBe('clxyz123');
    expect(decoded.createdAt).toBe('2026-09-01T12:00:00.000Z');
  });

  it('produces a base64url string (no +, /, or = padding)', () => {
    const cursor = encodeCursor(makeItem('abc', new Date()));
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('two items with different ids produce different cursors', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(encodeCursor(makeItem('id-1', d))).not.toBe(encodeCursor(makeItem('id-2', d)));
  });
});

// ---------------------------------------------------------------------------
// decodeCursor — invalid input
// ---------------------------------------------------------------------------

describe('decodeCursor — invalid input', () => {
  it('throws CursorError for a random string', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(CursorError);
  });

  it('throws CursorError for valid base64url but non-JSON content', () => {
    const bad = Buffer.from('hello world').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(CursorError);
  });

  it('throws CursorError when createdAt field is missing', () => {
    const bad = Buffer.from(JSON.stringify({ id: 'abc' })).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(CursorError);
  });

  it('throws CursorError when id field is missing', () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z' }),
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(CursorError);
  });

  it('throws CursorError when createdAt is not a valid date string', () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: 'not-a-date', id: 'abc' }),
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(CursorError);
  });

  it('throws CursorError for an empty string', () => {
    expect(() => decodeCursor('')).toThrow(CursorError);
  });
});

// ---------------------------------------------------------------------------
// buildCursorWhere
// ---------------------------------------------------------------------------

describe('buildCursorWhere', () => {
  it('returns an OR clause covering both tiebreak conditions', () => {
    const item = makeItem('cl9zzz', new Date('2026-06-15T10:00:00.000Z'));
    const cursor = encodeCursor(item);
    const where = buildCursorWhere(cursor) as any;

    expect(where).toHaveProperty('OR');
    expect(where.OR).toHaveLength(2);

    // First arm: any record with createdAt strictly before the cursor
    expect(where.OR[0]).toEqual({
      createdAt: { lt: new Date('2026-06-15T10:00:00.000Z') },
    });

    // Second arm: same timestamp, id strictly before cursor id
    expect(where.OR[1]).toEqual({
      createdAt: new Date('2026-06-15T10:00:00.000Z'),
      id: { lt: 'cl9zzz' },
    });
  });

  it('throws CursorError for a malformed cursor', () => {
    expect(() => buildCursorWhere('garbage')).toThrow(CursorError);
  });
});

// ---------------------------------------------------------------------------
// buildCursorPage
// ---------------------------------------------------------------------------

describe('buildCursorPage', () => {
  const items = Array.from({ length: 5 }, (_, i) =>
    makeItem(`id-${i}`, new Date(2026, 0, i + 1)),
  );

  it('returns all items and hasNextPage=false when rows ≤ limit', () => {
    const result = buildCursorPage(items, 5);
    expect(result.items).toHaveLength(5);
    expect(result.pagination.hasNextPage).toBe(false);
    expect(result.pagination.nextCursor).toBeUndefined();
  });

  it('slices off the extra row and sets hasNextPage=true when rows > limit', () => {
    // Simulate fetching limit+1 rows (6 rows, limit=5)
    const sixRows = [...items, makeItem('id-5', new Date(2026, 0, 6))];
    const result = buildCursorPage(sixRows, 5);

    expect(result.items).toHaveLength(5);
    expect(result.pagination.hasNextPage).toBe(true);
    expect(result.pagination.nextCursor).toBeDefined();
  });

  it('nextCursor encodes the last visible item (not the extra row)', () => {
    const sixRows = [...items, makeItem('id-5', new Date(2026, 0, 6))];
    const result = buildCursorPage(sixRows, 5);

    // The last visible item is items[4] = id-4
    const decoded = decodeCursor(result.pagination.nextCursor!);
    expect(decoded.id).toBe('id-4');
  });

  it('returns empty items and hasNextPage=false for an empty array', () => {
    const result = buildCursorPage([], 20);
    expect(result.items).toHaveLength(0);
    expect(result.pagination.hasNextPage).toBe(false);
    expect(result.pagination.nextCursor).toBeUndefined();
  });

  it('includes the limit in the pagination envelope', () => {
    const result = buildCursorPage(items, 10);
    expect(result.pagination.limit).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

describe('limitSchema', () => {
  it('defaults to 20 when absent', () => {
    expect(limitSchema.parse(undefined)).toBe(20);
  });

  it('coerces a string to number', () => {
    expect(limitSchema.parse('50')).toBe(50);
  });

  it('rejects 0', () => {
    expect(() => limitSchema.parse(0)).toThrow();
  });

  it('rejects 101', () => {
    expect(() => limitSchema.parse(101)).toThrow();
  });

  it('accepts boundary values 1 and 100', () => {
    expect(limitSchema.parse(1)).toBe(1);
    expect(limitSchema.parse(100)).toBe(100);
  });
});

describe('cursorPaginationQuerySchema', () => {
  it('parses an empty object with defaults', () => {
    const result = cursorPaginationQuerySchema.parse({});
    expect(result.limit).toBe(20);
    expect(result.cursor).toBeUndefined();
  });

  it('accepts a valid cursor string', () => {
    const cursor = encodeCursor(makeItem('abc', new Date()));
    const result = cursorPaginationQuerySchema.parse({ cursor });
    expect(result.cursor).toBe(cursor);
  });
});
