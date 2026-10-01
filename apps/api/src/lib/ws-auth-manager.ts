/**
 * WsAuthManager
 *
 * Tracks the expiry time of the JWT that authenticated a WebSocket connection
 * and fires a proactive warning before the token expires so the client can
 * reauthenticate (send a new token) before being disconnected.
 *
 * Design decisions:
 * - "Warn-before-expiry" pattern: We warn the client ~60 s before expiry so
 *   it has time to obtain a fresh token via the HTTP /auth/refresh endpoint
 *   and reconnect, rather than simply being cut off mid-session.
 * - Single timer per connection: We hold one NodeJS.Timeout per entry. The
 *   timer is cancelled and replaced whenever the client re-authenticates with
 *   a newer token (token rotation).
 * - No in-process refresh: The server never holds the refresh token; the
 *   client is responsible for calling /auth/refresh and then reconnecting
 *   with the new access token. This keeps the auth boundary clean.
 */

import { createLogger } from './logger';

const log = createLogger({ module: 'WsAuthManager' });

/** How many seconds before expiry we send the warning. */
export const EXPIRY_WARN_BEFORE_SECONDS = 60;

export interface WsAuthEntry {
  userId: string;
  /** Unix epoch in seconds (the `exp` claim from the JWT). */
  tokenExp: number;
  onExpiring: () => void;
  onExpired: () => void;
}

interface ManagedEntry {
  warnTimer: ReturnType<typeof setTimeout> | null;
  expireTimer: ReturnType<typeof setTimeout> | null;
}

export class WsAuthManager {
  private entries = new Map<WsAuthEntry, ManagedEntry>();

  /**
   * Begin tracking an authenticated connection.
   * - `onExpiring()` fires EXPIRY_WARN_BEFORE_SECONDS seconds before expiry.
   * - `onExpired()` fires exactly at the expiry moment.
   *
   * If the token is already expired (or expires within the warn window), the
   * callbacks fire immediately in the next tick.
   */
  track(entry: WsAuthEntry): void {
    // Cancel any previous timers for this entry (re-auth case).
    this.untrack(entry);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const secondsUntilExpiry = entry.tokenExp - nowSeconds;

    if (secondsUntilExpiry <= 0) {
      // Already expired — fire immediately (next tick) and bail.
      log.warn(`WsAuthManager: token for user ${entry.userId.substring(0, 8)}… is already expired`);
      setImmediate(() => entry.onExpired());
      this.entries.set(entry, { warnTimer: null, expireTimer: null });
      return;
    }

    const warnDelayMs = Math.max(0, (secondsUntilExpiry - EXPIRY_WARN_BEFORE_SECONDS) * 1000);
    const expireDelayMs = secondsUntilExpiry * 1000;

    const managed: ManagedEntry = {
      warnTimer:
        warnDelayMs > 0
          ? setTimeout(() => {
              log.info(
                `WsAuthManager: sending expiry warning for user ${entry.userId.substring(0, 8)}…`,
              );
              entry.onExpiring();
            }, warnDelayMs)
          : null,
      expireTimer: setTimeout(() => {
        log.info(
          `WsAuthManager: token expired for user ${entry.userId.substring(0, 8)}…`,
        );
        entry.onExpired();
        this.entries.delete(entry);
      }, expireDelayMs),
    };

    // Node keeps the process alive while timers are pending. `unref()` makes
    // these timers non-blocking so they don't prevent graceful shutdown.
    managed.warnTimer?.unref();
    managed.expireTimer.unref();

    this.entries.set(entry, managed);
  }

  /**
   * Stop tracking an entry (call on socket close / unregister).
   * Safe to call even if the entry was never tracked.
   */
  untrack(entry: WsAuthEntry): void {
    const managed = this.entries.get(entry);
    if (!managed) return;
    if (managed.warnTimer) clearTimeout(managed.warnTimer);
    if (managed.expireTimer) clearTimeout(managed.expireTimer);
    this.entries.delete(entry);
  }

  /** Number of actively tracked connections (useful for tests / metrics). */
  activeCount(): number {
    return this.entries.size;
  }
}
