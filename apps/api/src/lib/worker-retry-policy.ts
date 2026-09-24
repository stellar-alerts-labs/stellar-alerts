export type WorkerFailureClass = 'retryable' | 'permanent';

export interface WorkerFailureClassification {
  classification: WorkerFailureClass;
  reason: string;
  message: string;
}

export class PermanentWorkerError extends Error {
  readonly failureClass = 'permanent' as const;
  readonly reason: string;

  constructor(message: string, reason = 'invalid_job') {
    super(`[permanent:${reason}] ${message}`);
    this.name = 'PermanentWorkerError';
    this.reason = reason;
  }
}

export function getWorkerMaxAttempts(): number {
  const configured = Number.parseInt(process.env.WORKER_MAX_ATTEMPTS || '5', 10);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 20) : 5;
}

export function classifyWorkerError(error: unknown): WorkerFailureClassification {
  const value = error as { message?: unknown; statusCode?: unknown; code?: unknown; reason?: unknown };
  const message = value?.message ? String(value.message) : String(error);
  const statusCode = typeof value?.statusCode === 'number' ? value.statusCode : undefined;

  const permanentReason = message.match(/^\[permanent:([^\]]+)\]/)?.[1];
  if (permanentReason) {
    return { classification: 'permanent', reason: permanentReason, message };
  }

  if (error instanceof PermanentWorkerError) {
    return { classification: 'permanent', reason: error.reason, message };
  }

  if ([400, 401, 403, 404, 422].includes(statusCode ?? 0)) {
    return { classification: 'permanent', reason: `http_${statusCode}`, message };
  }

  if (/validation|invalid (?:job|payload|argument)|malformed|unsupported/i.test(message)) {
    return { classification: 'permanent', reason: 'invalid_job', message };
  }

  if (typeof value?.reason === 'string' && value.reason.length > 0) {
    return { classification: 'retryable', reason: value.reason, message };
  }

  return {
    classification: 'retryable',
    reason: typeof value?.code === 'string' ? value.code : 'worker_error',
    message,
  };
}