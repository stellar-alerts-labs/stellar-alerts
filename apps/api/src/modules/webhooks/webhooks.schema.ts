import { z } from 'zod';
import { MAX_WEBHOOK_URL_LENGTH, validateWebhookTargetUrl } from '@stellar-alerts/shared';
import { cursorSchema, limitSchema } from '../../utils/pagination';

export const createWebhookSchema = z.object({
  url: z
    .string()
    .max(MAX_WEBHOOK_URL_LENGTH)
    .refine(validateWebhookTargetUrl, {
      message: 'URL must be a valid HTTP(S) URL without credentials and use an allowed port',
    }),
  payloadTemplate: z.string().max(16384).optional(),
});

export const webhookParamsSchema = z.object({
  id: z.string().min(1),
});

export const listWebhookLogsQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
});

export const SANDBOX_EVENT_TYPES = ['payment', 'soroban', 'multisig'] as const;
export const SANDBOX_MOCK_STATUS_CODES = [200, 429, 500] as const;

// POST /webhooks/sandbox/replay. With `mockStatusCode` the receiver is
// simulated and no network I/O happens; without it the payload is dispatched
// to `targetUrl` through the SSRF-safe client.
export const sandboxReplaySchema = z.object({
  eventType: z.enum(SANDBOX_EVENT_TYPES),
  targetUrl: z.string().url().max(2048),
  mockStatusCode: z
    .number()
    .int()
    .refine((code) => (SANDBOX_MOCK_STATUS_CODES as readonly number[]).includes(code), {
      message: `mockStatusCode must be one of ${SANDBOX_MOCK_STATUS_CODES.join(', ')}`,
    })
    .optional(),
  maxAttempts: z.number().int().min(1).max(5).default(3),
});

export type SandboxReplayInput = z.infer<typeof sandboxReplaySchema>;

// POST /webhooks/certification/run. The subscriber supplies the shared secret
// its receiver verifies with; the previous secret enables the rotation probe.
export const certificationRunSchema = z.object({
  targetUrl: z.string().url().max(2048),
  secret: z.string().min(8).max(512),
  previousSecret: z.string().min(8).max(512).optional(),
});

export type CertificationRunInput = z.infer<typeof certificationRunSchema>;
