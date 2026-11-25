import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RelativeTime } from './RelativeTime';
import { formatRelativeTime } from '@/hooks/useRelativeTicker';

// ---------------------------------------------------------------------------
// Mock the ticker hook so we can drive re-renders manually in component tests.
// The pure formatRelativeTime function is tested independently below.
// ---------------------------------------------------------------------------
let emitTick: (() => void) | null = null;

vi.mock('@/hooks/useRelativeTicker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useRelativeTicker')>();
  return {
    ...actual,
    useRelativeTicker: vi.fn(() => {
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        emitTick = () => setTick((t) => t + 1);
        return () => { emitTick = null; };
      }, []);
      return tick;
    }),
  };
});

// ---------------------------------------------------------------------------
// formatRelativeTime unit tests (pure function, no timers needed)
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for timestamps less than 10 seconds ago', () => {
    const now = new Date();
    vi.setSystemTime(now);
    expect(formatRelativeTime(new Date(now.getTime() - 5_000))).toBe('just now');
    expect(formatRelativeTime(new Date(now.getTime() - 9_999))).toBe('just now');
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('returns seconds for timestamps 10–59 seconds ago', () => {
    const now = new Date();
    vi.setSystemTime(now);
    expect(formatRelativeTime(new Date(now.getTime() - 10_000))).toBe('10s ago');
    expect(formatRelativeTime(new Date(now.getTime() - 45_000))).toBe('45s ago');
    expect(formatRelativeTime(new Date(now.getTime() - 59_000))).toBe('59s ago');
  });

  it('returns minutes for timestamps 1–59 minutes ago', () => {
    const now = new Date();
    vi.setSystemTime(now);
    expect(formatRelativeTime(new Date(now.getTime() - 60_000))).toBe('1m ago');
    expect(formatRelativeTime(new Date(now.getTime() - 4 * 60_000))).toBe('4m ago');
    expect(formatRelativeTime(new Date(now.getTime() - 59 * 60_000))).toBe('59m ago');
  });

  it('returns hours for timestamps 1–23 hours ago', () => {
    const now = new Date();
    vi.setSystemTime(now);
    expect(formatRelativeTime(new Date(now.getTime() - 60 * 60_000))).toBe('1h ago');
    expect(formatRelativeTime(new Date(now.getTime() - 5 * 60 * 60_000))).toBe('5h ago');
    expect(formatRelativeTime(new Date(now.getTime() - 23 * 60 * 60_000))).toBe('23h ago');
  });

  it('returns days for timestamps 1+ days ago', () => {
    const now = new Date();
    vi.setSystemTime(now);
    expect(formatRelativeTime(new Date(now.getTime() - 24 * 60 * 60_000))).toBe('1d ago');
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 24 * 60 * 60_000))).toBe('3d ago');
  });

  it('accepts ISO strings as input', () => {
    const now = new Date();
    vi.setSystemTime(now);
    const iso = new Date(now.getTime() - 2 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe('2m ago');
  });

  it('accepts epoch milliseconds as input', () => {
    const now = new Date();
    vi.setSystemTime(now);
    const epochMs = now.getTime() - 30_000;
    expect(formatRelativeTime(epochMs)).toBe('30s ago');
  });
});

// ---------------------------------------------------------------------------
// RelativeTime component tests
// ---------------------------------------------------------------------------

describe('RelativeTime component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a <time> element with the ISO dateTime attribute', () => {
    const now = new Date();
    vi.setSystemTime(now);
    const ts = new Date(now.getTime() - 30_000);

    render(<RelativeTime timestamp={ts} />);

    const el = screen.getByRole('time');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('dateTime', ts.toISOString());
  });

  it('shows the correct initial relative string', () => {
    const now = new Date();
    vi.setSystemTime(now);
    const ts = new Date(now.getTime() - 2 * 60_000);

    render(<RelativeTime timestamp={ts} />);

    expect(screen.getByRole('time')).toHaveTextContent('2m ago');
  });

  it('exposes the full UTC ISO string in the title tooltip', () => {
    const now = new Date();
    vi.setSystemTime(now);
    const ts = new Date(now.getTime() - 60_000);

    render(<RelativeTime timestamp={ts} />);

    expect(screen.getByRole('time')).toHaveAttribute('title', ts.toISOString());
  });

  it('re-renders with a fresh relative string when the ticker fires', async () => {
    const base = new Date('2025-01-01T00:00:00.000Z');
    vi.setSystemTime(base);
    // Timestamp is 5s old → 'just now'
    const ts = new Date(base.getTime() - 5_000);

    render(<RelativeTime timestamp={ts} />);
    expect(screen.getByRole('time')).toHaveTextContent('just now');

    // The mock useRelativeTicker sets emitTick inside a useEffect.
    // Testing Library's render() wraps in act(), so effects have already run.
    // Advance system clock by 10s so the timestamp is now 15s old, then
    // fire the ticker to trigger a re-render.
    vi.advanceTimersByTime(10_000);
    act(() => { emitTick?.(); });

    expect(screen.getByRole('time')).toHaveTextContent('15s ago');
  });

  it('accepts an ISO string as the timestamp prop', () => {
    const now = new Date();
    vi.setSystemTime(now);
    const iso = new Date(now.getTime() - 45_000).toISOString();

    render(<RelativeTime timestamp={iso} />);

    expect(screen.getByRole('time')).toHaveTextContent('45s ago');
  });

  it('accepts epoch milliseconds as the timestamp prop', () => {
    const now = new Date();
    vi.setSystemTime(now);
    const epochMs = now.getTime() - 3 * 60 * 60_000;

    render(<RelativeTime timestamp={epochMs} />);

    expect(screen.getByRole('time')).toHaveTextContent('3h ago');
  });
});
