import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsAuthManager, WsAuthEntry, EXPIRY_WARN_BEFORE_SECONDS } from '../ws-auth-manager';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeEntry(overrides: Partial<WsAuthEntry> = {}): WsAuthEntry & {
  onExpiring: ReturnType<typeof vi.fn>;
  onExpired: ReturnType<typeof vi.fn>;
} {
  return {
    userId: 'user-test-1',
    tokenExp: nowSeconds() + 300, // expires in 5 min by default
    onExpiring: vi.fn(),
    onExpired: vi.fn(),
    ...overrides,
  };
}

describe('WsAuthManager', () => {
  let manager: WsAuthManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new WsAuthManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // activeCount
  // ---------------------------------------------------------------------------

  it('starts with zero active entries', () => {
    expect(manager.activeCount()).toBe(0);
  });

  it('increments activeCount when an entry is tracked', () => {
    const entry = makeEntry();
    manager.track(entry);
    expect(manager.activeCount()).toBe(1);
  });

  it('decrements activeCount when an entry is untracked', () => {
    const entry = makeEntry();
    manager.track(entry);
    manager.untrack(entry);
    expect(manager.activeCount()).toBe(0);
  });

  it('does not throw when untracking an entry that was never tracked', () => {
    const entry = makeEntry();
    expect(() => manager.untrack(entry)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // onExpiring callback
  // ---------------------------------------------------------------------------

  it('fires onExpiring ~EXPIRY_WARN_BEFORE_SECONDS seconds before expiry', () => {
    const expiry = nowSeconds() + 200; // 200s from now
    const entry = makeEntry({ tokenExp: expiry });
    manager.track(entry);

    // Advance to just before the warn threshold — should not have fired yet
    const warnDelayMs = (200 - EXPIRY_WARN_BEFORE_SECONDS) * 1000;
    vi.advanceTimersByTime(warnDelayMs - 1);
    expect(entry.onExpiring).not.toHaveBeenCalled();

    // Advance past the warn threshold
    vi.advanceTimersByTime(2);
    expect(entry.onExpiring).toHaveBeenCalledOnce();
    expect(entry.onExpired).not.toHaveBeenCalled();
  });

  it('does not fire onExpiring when token expires within the warn window (fires onExpired only)', () => {
    // Token expires in 30s — less than EXPIRY_WARN_BEFORE_SECONDS (60s),
    // so warnDelayMs = 0 and no warn timer is set.
    const entry = makeEntry({ tokenExp: nowSeconds() + 30 });
    manager.track(entry);

    vi.advanceTimersByTime(30_000);

    // onExpired fires; onExpiring never fires because the window had passed
    expect(entry.onExpired).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // onExpired callback
  // ---------------------------------------------------------------------------

  it('fires onExpired at expiry time', () => {
    const entry = makeEntry({ tokenExp: nowSeconds() + 100 });
    manager.track(entry);

    vi.advanceTimersByTime(99_999);
    expect(entry.onExpired).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(entry.onExpired).toHaveBeenCalledOnce();
  });

  it('removes the entry from activeCount once onExpired fires', () => {
    const entry = makeEntry({ tokenExp: nowSeconds() + 50 });
    manager.track(entry);
    expect(manager.activeCount()).toBe(1);

    vi.advanceTimersByTime(50_000 + 10);
    expect(manager.activeCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Already-expired token
  // ---------------------------------------------------------------------------

  it('fires onExpired immediately (next tick) when token is already expired', async () => {
    const entry = makeEntry({ tokenExp: nowSeconds() - 10 });
    manager.track(entry);

    // setImmediate fires after flushing the current microtask queue
    await vi.runAllTimersAsync();
    expect(entry.onExpired).toHaveBeenCalledOnce();
    expect(entry.onExpiring).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Re-auth / token rotation: untrack + re-track replaces timer
  // ---------------------------------------------------------------------------

  it('cancels old timers when the same entry is re-tracked with a new token', () => {
    const entry = makeEntry({ tokenExp: nowSeconds() + 300 });
    manager.track(entry);

    // Simulate re-auth: update tokenExp and re-track
    entry.tokenExp = nowSeconds() + 600;
    manager.track(entry); // should cancel old timers and install new ones

    // Advance past the original expiry; callbacks must NOT fire because the
    // entry was re-tracked with a later expiry.
    vi.advanceTimersByTime(300_000 + 100);
    expect(entry.onExpired).not.toHaveBeenCalled();

    // Advance to the new expiry
    vi.advanceTimersByTime(300_000);
    expect(entry.onExpired).toHaveBeenCalledOnce();
  });

  it('does not double-fire callbacks when untrack is called before expiry', () => {
    const entry = makeEntry({ tokenExp: nowSeconds() + 100 });
    manager.track(entry);

    manager.untrack(entry);
    vi.advanceTimersByTime(200_000);

    expect(entry.onExpired).not.toHaveBeenCalled();
    expect(entry.onExpiring).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Multiple independent entries
  // ---------------------------------------------------------------------------

  it('tracks multiple entries independently', () => {
    const entryA = makeEntry({ userId: 'user-a', tokenExp: nowSeconds() + 100 });
    const entryB = makeEntry({ userId: 'user-b', tokenExp: nowSeconds() + 200 });

    manager.track(entryA);
    manager.track(entryB);
    expect(manager.activeCount()).toBe(2);

    vi.advanceTimersByTime(100_000 + 50);
    expect(entryA.onExpired).toHaveBeenCalledOnce();
    expect(entryB.onExpired).not.toHaveBeenCalled();
    expect(manager.activeCount()).toBe(1);

    vi.advanceTimersByTime(100_000);
    expect(entryB.onExpired).toHaveBeenCalledOnce();
    expect(manager.activeCount()).toBe(0);
  });
});
