import { z } from 'zod';
import { requestLinkSchema, verifyLinkSchema, didChallengeSchema, didVerifySchema } from './modules/auth/auth.schema';
import { createWalletSchema } from './modules/wallets/wallets.schema';
import { createWebhookSchema } from './modules/webhooks/webhooks.schema';
import {
  deadLetterIdSchema,
  listDeadLettersQuerySchema,
  suppressDeadLetterSchema,
  sandboxReplayIdSchema,
  sandboxReplayInputSchema,
  listSandboxReplaysQuerySchema,
} from './modules/dead-letters/dead-letters.schema';
import {
  createExportSchema,
  downloadExportQuerySchema,
  exportIdSchema,
  listExportsQuerySchema,
} from './modules/exports/exports.schema';
import {
  analyzeSimulationSchema,
  simulationIdSchema,
  listSimulationsQuerySchema,
} from './modules/simulation/simulation.schema';

/**
 * The one envelope shape every thrown AppError (lib/errors.ts) is
 * serialized into by app.ts's setErrorHandler — see that file for the
 * full rationale. Published here as a reusable OpenAPI component so it
 * can be referenced from any route's 4xx/5xx response documentation
 * instead of each route describing its own ad-hoc error shape.
 */
const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().describe('Stable, machine-readable error code (e.g. VALIDATION_ERROR, NOT_FOUND, CONFLICT).'),
    message: z.string().describe('Human-readable, client-safe message. Never contains internal/sensitive detail.'),
    details: z.unknown().optional().describe('Optional structured detail, e.g. field-level validation errors.'),
    requestId: z.string().describe('Correlation id — also returned as the x-request-id response header.'),
  }),
});

/**
 * The `@fastify/swagger` registration options shared by `buildApp()`
 * (`app.ts`) and `scripts/generate-types.ts`.
 *
 * This module is deliberately kept free of anything that reaches into
 * `./config/env` or the route modules: it only imports the Zod request
 * schemas themselves. That lets the type generator build the OpenAPI
 * document (and derive `@stellar-alerts/shared`'s generated types from it)
 * without loading env validation, Postgres, or Redis — see
 * docs/type-generation.md for the full rationale.
 */

export const openApiComponentSchemas = {
  RequestLinkInput: z.toJSONSchema(requestLinkSchema),
  VerifyLinkInput: z.toJSONSchema(verifyLinkSchema),
  DIDChallengeInput: z.toJSONSchema(didChallengeSchema),
  DIDVerifyInput: z.toJSONSchema(didVerifySchema),
  CreateWalletInput: z.toJSONSchema(createWalletSchema),
  CreateWebhookInput: z.toJSONSchema(createWebhookSchema),
  DeadLetterIdParams: z.toJSONSchema(deadLetterIdSchema),
  ListDeadLettersQuery: z.toJSONSchema(listDeadLettersQuerySchema),
  SuppressDeadLetterInput: z.toJSONSchema(suppressDeadLetterSchema),
  SandboxReplayIdParams: z.toJSONSchema(sandboxReplayIdSchema),
  SandboxReplayInput: z.toJSONSchema(sandboxReplayInputSchema),
  ListSandboxReplaysQuery: z.toJSONSchema(listSandboxReplaysQuerySchema),
  ErrorResponse: z.toJSONSchema(errorResponseSchema),
  CreateExportInput: z.toJSONSchema(createExportSchema),
  ExportIdParams: z.toJSONSchema(exportIdSchema),
  ListExportsQuery: z.toJSONSchema(listExportsQuerySchema),
  DownloadExportQuery: z.toJSONSchema(downloadExportQuerySchema),
  AnalyzeSimulationInput: z.toJSONSchema(analyzeSimulationSchema),
  SimulationIdParams: z.toJSONSchema(simulationIdSchema),
  ListSimulationsQuery: z.toJSONSchema(listSimulationsQuerySchema),
};

export const openApiOptions = {
  openapi: {
    info: {
      title: 'Stellar Alerts API',
      description:
        'Interactive API documentation for the Stellar Payment Tracker. Register wallets, monitor payments and manage webhook alert endpoints.',
      version: '1.0.0',
    },
    tags: [
      { name: 'auth', description: 'Magic-link authentication' },
      { name: 'wallets', description: 'Watched Stellar wallet management' },
      { name: 'payments', description: 'Incoming payment history and summaries' },
      { name: 'webhooks', description: 'Custom webhook alert endpoint management' },
      { name: 'dead-letters', description: 'Inspection, replay and suppression of failed notification deliveries' },
      { name: 'webhook-sandbox', description: 'Sandbox replay of dead letters against a mock webhook receiver with response inspection' },
      { name: 'exports', description: 'Asynchronous CSV/PDF export jobs with progress and signed downloads' },
      { name: 'simulations', description: 'Pre-execution transaction envelope simulation with explainable threat scoring' },
    ],
    components: {
      schemas: openApiComponentSchemas as Record<string, any>,
    },
  },
};
