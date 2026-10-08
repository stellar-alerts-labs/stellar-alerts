import { z } from 'zod';
import { cursorSchema, limitSchema } from '../../utils/pagination';

// Prisma IDs are CUIDs (model id fields use `@default(cuid())`), so route
// params must be strict CUIDs: `c` prefix + base36 lowercase. Anything else
// ('' , 'invalid-id', '123', 'not-a-cuid', over-long strings) fails schema
// validation → 400 VALIDATION_ERROR instead of a misleading 404.
export const deadLetterIdSchema = z.object({
  id: z
    .string()
    .regex(/^c[a-z0-9]{24,}$/, 'Invalid dead letter id'),
});

export const listDeadLettersQuerySchema = z.object({
  channel: z.string().min(1).max(40).optional(),
  status: z.enum(['pending', 'retried', 'suppressed']).optional(),
  q: z.string().max(200).optional(),
  maxAgeDays: z.coerce.number().int().min(1).max(365).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

export const suppressDeadLetterSchema = z.object({
  note: z.string().max(2000).optional(),
});

export const sandboxReplayIdSchema = z.object({
  replayId: z.string().min(1),
});

// Mock response the in-process sandbox receiver should return. Mirrors what a
// real receiver would produce so developers can exercise success paths,
// provider 4xx/5xx responses, and latency before wiring a real endpoint.
export const sandboxMockResponseSchema = z.object({
  // HTTP status the mock receiver responds with (default 200 = accepted).
  status: z.number().int().min(100).max(599).default(200),
  // Response headers echoed back by the mock receiver (at most 50 entries).
  headers: z
    // z.object({}).catchall(z.string()) instead of z.record(z.string(), z.string()): both
    // accept string-keyed/string-valued objects, but z.record() emits `propertyNames`
    // (JSON Schema Draft-07) which openapi-diff rejects as invalid OpenAPI 3.0.
    // catchall() emits only `additionalProperties` which is valid in OpenAPI 3.0.
    .object({})
    .catchall(z.string())
    .refine((headers) => Object.keys(headers).length <= 50, {
      message: 'At most 50 response headers are allowed',
    })
    .default({}),
  // Raw response body returned by the mock receiver (max 64 KB).
  body: z.string().max(65536).default(''),
  // Artificial delay (ms) the mock receiver waits before responding.
  // Capped at 5s so replays can never stall API workers.
  delayMs: z.number().int().min(0).max(5000).default(0),
});

export const sandboxReplayInputSchema = z.object({
  mockStatusCode: z.coerce.number().int().min(100).max(599).optional().default(200),
  mockResponseBody: z.string().optional(),
  mockResponseHeaders: z.record(z.string(), z.string()).optional(),
});

export const listSandboxReplaysQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
});

export type SandboxMockResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
  delayMs: number;
};
