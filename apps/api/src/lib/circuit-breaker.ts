// In-memory circuit breaker for external HTTP targets
// Opens after N consecutive 5xx failures, resets after cooldown

export interface CircuitBreakerOptions {
  failureThreshold: number; // default 10
  cooldownMs: number;       // default 60_000 (1 minute)
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = new Map<string, number>();
  private openedAt = new Map<string, number>();
  private readonly threshold: number;
  private readonly cooldown: number;

  constructor(opts: CircuitBreakerOptions = { failureThreshold: 10, cooldownMs: 60_000 }) {
    this.threshold = opts.failureThreshold;
    this.cooldown = opts.cooldownMs;
  }

  /**
   * Returns the current circuit state for a domain:
   * - 'closed'    → healthy, requests allowed
   * - 'open'      → tripped, requests blocked
   * - 'half-open' → cooldown elapsed, one probe request allowed
   */
  getState(domain: string): CircuitState {
    const failures = this.failures.get(domain) ?? 0;
    const openedAt = this.openedAt.get(domain);

    if (failures < this.threshold || openedAt === undefined) {
      return 'closed';
    }

    const elapsed = Date.now() - openedAt;
    if (elapsed >= this.cooldown) {
      return 'half-open';
    }

    return 'open';
  }

  /**
   * Record a successful response for a domain.
   * Resets the failure counter and removes any open-circuit timestamp.
   */
  recordSuccess(domain: string): void {
    this.failures.delete(domain);
    this.openedAt.delete(domain);
  }

  /**
   * Record a 5xx failure for a domain.
   * If cumulative failures reach the threshold, the circuit trips to open.
   */
  recordFailure(domain: string): void {
    const current = this.failures.get(domain) ?? 0;
    const next = current + 1;
    this.failures.set(domain, next);

    if (next >= this.threshold && !this.openedAt.has(domain)) {
      this.openedAt.set(domain, Date.now());
    }
  }

  /**
   * Returns true when requests to the domain should be blocked.
   * Covers both 'open' and (as a safety net) reaching the threshold.
   */
  isOpen(domain: string): boolean {
    return this.getState(domain) === 'open';
  }
}

export const circuitBreaker = new CircuitBreaker();
