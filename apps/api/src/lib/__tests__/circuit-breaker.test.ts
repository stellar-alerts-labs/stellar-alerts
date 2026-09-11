import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker } from '../circuit-breaker';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    // Use a threshold of 3 failures and a 1-second cooldown for fast tests
    cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    it('starts as closed for an unknown domain', () => {
      expect(cb.getState('example.com')).toBe('closed');
      expect(cb.isOpen('example.com')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Closed → Open transition
  // ---------------------------------------------------------------------------
  describe('closed → open transition', () => {
    it('stays closed while failures are below the threshold', () => {
      cb.recordFailure('example.com');
      cb.recordFailure('example.com');
      expect(cb.getState('example.com')).toBe('closed');
      expect(cb.isOpen('example.com')).toBe(false);
    });

    it('opens after exactly N consecutive failures', () => {
      cb.recordFailure('example.com');
      cb.recordFailure('example.com');
      cb.recordFailure('example.com'); // 3rd failure hits threshold
      expect(cb.getState('example.com')).toBe('open');
      expect(cb.isOpen('example.com')).toBe(true);
    });

    it('remains open for additional failures beyond threshold', () => {
      for (let i = 0; i < 5; i++) cb.recordFailure('example.com');
      expect(cb.getState('example.com')).toBe('open');
      expect(cb.isOpen('example.com')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Open → Half-Open transition (after cooldown)
  // ---------------------------------------------------------------------------
  describe('open → half-open transition', () => {
    it('transitions to half-open after the cooldown period elapses', () => {
      vi.useFakeTimers();

      for (let i = 0; i < 3; i++) cb.recordFailure('example.com');
      expect(cb.getState('example.com')).toBe('open');

      // Advance past the 1-second cooldown
      vi.advanceTimersByTime(1001);

      expect(cb.getState('example.com')).toBe('half-open');
      expect(cb.isOpen('example.com')).toBe(false);
    });

    it('remains open before the cooldown elapses', () => {
      vi.useFakeTimers();

      for (let i = 0; i < 3; i++) cb.recordFailure('example.com');
      vi.advanceTimersByTime(500); // half the cooldown

      expect(cb.getState('example.com')).toBe('open');
    });
  });

  // ---------------------------------------------------------------------------
  // Half-Open → Closed on success
  // ---------------------------------------------------------------------------
  describe('half-open → closed on success', () => {
    it('resets to closed after a success in half-open state', () => {
      vi.useFakeTimers();

      for (let i = 0; i < 3; i++) cb.recordFailure('example.com');
      vi.advanceTimersByTime(1001);
      expect(cb.getState('example.com')).toBe('half-open');

      cb.recordSuccess('example.com');
      expect(cb.getState('example.com')).toBe('closed');
      expect(cb.isOpen('example.com')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // recordSuccess resets failure counter
  // ---------------------------------------------------------------------------
  describe('recordSuccess', () => {
    it('resets an in-progress failure count before the circuit opens', () => {
      cb.recordFailure('example.com');
      cb.recordFailure('example.com');
      cb.recordSuccess('example.com'); // probe succeeds → reset

      // Needs another full threshold of failures to re-open
      cb.recordFailure('example.com');
      cb.recordFailure('example.com');
      expect(cb.getState('example.com')).toBe('closed');

      cb.recordFailure('example.com');
      expect(cb.getState('example.com')).toBe('open');
    });

    it('is a no-op on a domain with no recorded failures', () => {
      cb.recordSuccess('unknown.com');
      expect(cb.getState('unknown.com')).toBe('closed');
    });
  });

  // ---------------------------------------------------------------------------
  // Domain isolation
  // ---------------------------------------------------------------------------
  describe('domain isolation', () => {
    it('tracks failures independently per domain', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('bad.com');
      expect(cb.getState('bad.com')).toBe('open');
      expect(cb.getState('good.com')).toBe('closed');
    });

    it('success on one domain does not affect another', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('bad.com');
      cb.recordSuccess('good.com');
      expect(cb.getState('bad.com')).toBe('open');
    });
  });

  // ---------------------------------------------------------------------------
  // Default constructor options
  // ---------------------------------------------------------------------------
  describe('default options', () => {
    it('uses failureThreshold=10 and cooldownMs=60_000 by default', () => {
      vi.useFakeTimers();
      const defaultCb = new CircuitBreaker();

      for (let i = 0; i < 9; i++) defaultCb.recordFailure('api.example.com');
      expect(defaultCb.getState('api.example.com')).toBe('closed');

      defaultCb.recordFailure('api.example.com'); // 10th
      expect(defaultCb.getState('api.example.com')).toBe('open');

      vi.advanceTimersByTime(59_999);
      expect(defaultCb.getState('api.example.com')).toBe('open');

      vi.advanceTimersByTime(1);
      expect(defaultCb.getState('api.example.com')).toBe('half-open');
    });
  });
});
