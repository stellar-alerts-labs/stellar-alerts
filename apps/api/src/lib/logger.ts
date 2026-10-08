/**
 * Shared structured Pino logger for API and workers.
 *
 * Provides:
 *  - Machine-queryable JSON logs with consistent level labels
 *  - Redaction of tokens, secrets, private keys, and message contents
 *  - Request correlation via `requestId` (aligned with Fastify)
 *  - Child loggers for workers / modules via `createLogger`
 *
 * Within Fastify routes, prefer `request.log` (inherits the same options and
 * automatically binds `requestId`). Outside the request lifecycle, use
 * `createLogger({ module, requestId })`.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';

/** Paths censored in every log line (Pino redact). */
export const REDACT_PATHS: string[] = [
  // Direct sensitive keys
  'password',
  'passwd',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'api_key',
  'privateKey',
  'private_key',
  'authorization',
  'cookie',
  'jwt',
  'seed',
  'mnemonic',
  'MASTER_ENCRYPTION_KEY',
  'JWT_SECRET',
  'TELEGRAM_BOT_TOKEN',
  // Nested / wildcard
  '*.password',
  '*.passwd',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.api_key',
  '*.privateKey',
  '*.private_key',
  '*.authorization',
  '*.cookie',
  '*.jwt',
  '*.seed',
  '*.mnemonic',
  // HTTP request shapes (Fastify serializers)
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers.cookie',
  // Message contents (alerts / notifications) — never emit plaintext bodies
  'messageContent',
  '*.messageContent',
  'messageBody',
  '*.messageBody',
  'plaintext',
  '*.plaintext',
  'emailBody',
  '*.emailBody',
  'telegramText',
  '*.telegramText',
  'notificationText',
  '*.notificationText',
];

export const REDACT_CENSOR = '[REDACTED]';

const SENSITIVE_KEY =
  /(?:password|passwd|secret|token|jwt|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|seed|mnemonic|messagecontent|messagebody|plaintext|emailbody|telegramtext|notificationtext)/i;

/**
 * Shared Pino options used by Fastify (`logger: loggerOptions`) and the
 * standalone `rootLogger` for workers.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.SERVICE_NAME ?? 'stellar-alerts',
    env: process.env.NODE_ENV ?? 'development',
  },
  redact: {
    paths: REDACT_PATHS,
    censor: REDACT_CENSOR,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      // Emit string levels (`info`) instead of numeric codes for queryability
      return { level: label };
    },
  },
};

/** Root logger – all child loggers inherit this configuration. */
export const rootLogger: Logger = pino(loggerOptions);

export type LoggerBindings = {
  requestId?: string;
  module?: string;
  jobId?: string;
  worker?: string;
};

/**
 * Create a child logger bound to optional correlation / module fields.
 *
 * @example
 * const log = createLogger({ requestId: job.data.requestId, module: 'WatcherWorker' });
 * log.info({ walletId }, 'Processing wallet payments');
 */
export function createLogger(bindings: LoggerBindings = {}): Logger {
  const fields: Record<string, string> = {};
  if (bindings.module) fields.module = bindings.module;
  if (bindings.requestId) fields.requestId = bindings.requestId;
  if (bindings.jobId) fields.jobId = bindings.jobId;
  if (bindings.worker) fields.worker = bindings.worker;
  return rootLogger.child(fields);
}

/**
 * Deep-sanitize an arbitrary object before logging when redaction paths
 * alone are not enough (e.g. dynamic keys). Returns a plain JSON-safe value.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACT_CENSOR;
    } else {
      out[key] = sanitizeForLog(child, depth + 1);
    }
  }
  return out;
}
