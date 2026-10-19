import { AsyncLocalStorage } from 'async_hooks';

export interface CorrelationStore {
  requestId: string;
}

export const correlationContext = new AsyncLocalStorage<CorrelationStore>();

/**
 * Returns the active correlation ID from the current async execution context.
 */
export function getCorrelationId(): string | undefined {
  return correlationContext.getStore()?.requestId;
}

/**
 * Runs a function within an explicit correlation ID async context.
 */
export function runWithCorrelationId<T>(requestId: string, fn: () => T): T {
  return correlationContext.run({ requestId }, fn);
}
