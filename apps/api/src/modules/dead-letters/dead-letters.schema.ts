import { z } from 'zod';
import { cursorSchema, limitSchema } from '../../utils/pagination';

export const deadLetterIdSchema = z.object({
  id: z.string().min(1),
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
  id: z.string().min(1),
});

export const sandboxReplayInputSchema = z.object({
  mockStatusCode: z.coerce.number().int().min(100).max(599).optional().default(200),
  mockResponseBody: z.string().optional(),
  mockResponseHeaders: z.record(z.string()).optional(),
});

export const listSandboxReplaysQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
});
