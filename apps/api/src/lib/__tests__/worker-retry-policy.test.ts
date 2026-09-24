import { describe, expect, it, afterEach } from 'vitest';
import {
  classifyWorkerError,
  getWorkerMaxAttempts,
  PermanentWorkerError,
} from '../worker-retry-policy';

describe('worker retry policy (#310)', () => {
  afterEach(() => {
    delete process.env.WORKER_MAX_ATTEMPTS;
  });

  it('classifies malformed jobs as permanent', () => {
    const result = classifyWorkerError(new PermanentWorkerError('missing paymentId', 'missing_payment_id'));

    expect(result).toEqual({
      classification: 'permanent',
      reason: 'missing_payment_id',
      message: '[permanent:missing_payment_id] missing paymentId',
    });
  });

  it('classifies infrastructure failures as retryable', () => {
    expect(classifyWorkerError(new Error('Redis connection reset'))).toMatchObject({
      classification: 'retryable',
      reason: 'worker_error',
    });
  });

  it('uses a bounded configurable attempt cap', () => {
    process.env.WORKER_MAX_ATTEMPTS = '99';
    expect(getWorkerMaxAttempts()).toBe(20);

    process.env.WORKER_MAX_ATTEMPTS = '0';
    expect(getWorkerMaxAttempts()).toBe(5);
  });
});