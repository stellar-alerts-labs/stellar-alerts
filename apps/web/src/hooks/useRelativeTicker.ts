'use client';

import { useState, useEffect } from 'react';

/** Shared 10-second interval ticker — all subscribers re-render together. */
const TICK_INTERVAL_MS = 10_000;

type TickCallback = () => void;
const subscribers = new Set<TickCallback>();
let timerId: ReturnType<typeof setInterval> | null = null;

function startTicker() {
  if (timerId !== null) return;
  timerId = setInterval(() => {
    subscribers.forEach((cb) => cb());
  }, TICK_INTERVAL_MS);
}

function stopTicker() {
  if (timerId === null) return;
  clearInterval(timerId);
  timerId = null;
}

function subscribe(cb: TickCallback): () => void {
  subscribers.add(cb);
  startTicker();
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0) stopTicker();
  };
}

/**
 * Returns a monotonically-increasing tick counter that increments every
 * 10 seconds via a shared interval.  Components that call this hook will
 * re-render in sync without each owning a private timer.
 */
export function useRelativeTicker(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribe(() => setTick((t) => t + 1));
    return unsubscribe;
  }, []);

  return tick;
}

/**
 * Formats a past Date (or ISO string / epoch ms) as a human-readable
 * relative string: 'just now', '15s ago', '4m ago', '2h ago', '3d ago'.
 */
export function formatRelativeTime(timestamp: Date | string | number): string {
  const then = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const diffMs = Date.now() - then.getTime();
  const diffSec = Math.floor(diffMs / 1_000);

  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}
