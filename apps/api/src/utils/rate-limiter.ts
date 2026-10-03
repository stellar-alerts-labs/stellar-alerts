// Per-domain rate limiter that respects Retry-After and X-RateLimit-Reset
// response headers from downstream notification webhooks.
//
// Supported headers (evaluated in priority order):
//   1. Retry-After      – seconds (integer) or HTTP-date
//   2. X-RateLimit-Reset – Unix timestamp (seconds)

export class AdaptiveRateLimiter {
  /** Maps domain -> Unix timestamp (ms) at which the block expires */
  private blockedUntil = new Map<string, number>();

  /**
   * Returns true if requests to this domain are currently rate-limited.
   */
  isBlocked(domain: string): boolean {
    const until = this.blockedUntil.get(domain);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.blockedUntil.delete(domain);
      return false;
    }
    return true;
  }

  /**
   * Parse a 429 response's headers to determine how long to back off.
   * Checks `Retry-After` first, then `X-RateLimit-Reset`.
   * Falls back to a 60-second default if neither header is present.
   */
  handleRateLimitResponse(domain: string, headers: Headers): void {
    const now = Date.now();
    let unblockAt: number | undefined;

    // --- Retry-After ---
    const retryAfter = headers.get('Retry-After');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds) && isFinite(seconds)) {
        // Integer seconds value
        unblockAt = now + seconds * 1000;
      } else {
        // HTTP-date value (e.g. "Wed, 26 Aug 2026 10:00:00 GMT")
        const parsed = Date.parse(retryAfter);
        if (!isNaN(parsed)) {
          unblockAt = parsed;
        }
      }
    }

    // --- X-RateLimit-Reset (Unix timestamp in seconds) ---
    if (unblockAt === undefined) {
      const rlReset = headers.get('X-RateLimit-Reset');
      if (rlReset !== null) {
        const ts = Number(rlReset);
        if (!isNaN(ts) && isFinite(ts)) {
          unblockAt = ts * 1000; // convert seconds -> ms
        }
      }
    }

    // --- Default fallback: 60 seconds ---
    if (unblockAt === undefined) {
      unblockAt = now + 60_000;
    }

    this.blockedUntil.set(domain, unblockAt);
  }

  /**
   * Returns the number of milliseconds remaining until the block expires.
   * Returns 0 if the domain is not blocked.
   */
  getRemainingMs(domain: string): number {
    const until = this.blockedUntil.get(domain);
    if (until === undefined) return 0;
    const remaining = until - Date.now();
    return remaining > 0 ? remaining : 0;
  }
}

export const adaptiveRateLimiter = new AdaptiveRateLimiter();
