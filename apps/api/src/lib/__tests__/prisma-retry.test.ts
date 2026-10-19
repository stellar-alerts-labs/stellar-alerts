import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConnect } = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../generated/prisma/client', () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    $connect: mockConnect,
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  })),
}));

import {
  connectWithRetry,
  computeDbRetryDelayMs,
  DEFAULT_DB_MAX_RETRIES,
} from '../prisma';

describe('Database connection retry strategy with exponential backoff (#537)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('connects immediately on the first attempt without sleeping when DB is ready', async () => {
    const mockClient = {
      $connect: vi.fn().mockResolvedValue(undefined),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);

    await connectWithRetry({ client: mockClient, sleep });

    expect(mockClient.$connect).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries with exponential backoff and recovers when Postgres boots after transient failures', async () => {
    const mockClient = {
      $connect: vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:5432'))
        .mockRejectedValueOnce(new Error('the database system is starting up'))
        .mockRejectedValueOnce(new Error('connection terminated unexpectedly'))
        .mockResolvedValueOnce(undefined),
    };
    const delays: number[] = [];
    const onRetry = vi.fn();

    await connectWithRetry({
      client: mockClient,
      baseDelayMs: 500,
      jitterRatio: 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
      onRetry,
    });

    expect(mockClient.$connect).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 1000, 2000]);
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it('retries 5 times by default before failing and invoking exitOnFailure', async () => {
    expect(DEFAULT_DB_MAX_RETRIES).toBe(5);

    const mockClient = {
      $connect: vi.fn().mockRejectedValue(new Error("P1001: Can't reach database server")),
    };
    const delays: number[] = [];
    const exitFn = vi.fn();

    await expect(
      connectWithRetry({
        client: mockClient,
        baseDelayMs: 100,
        jitterRatio: 0,
        exitOnFailure: true,
        exitFn,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toThrow(/P1001/);

    expect(mockClient.$connect).toHaveBeenCalledTimes(5);
    expect(delays).toEqual([100, 200, 400, 800]);
    expect(exitFn).toHaveBeenCalledWith(1);
  });

  it('computes exponential backoff with maxDelayMs cap and bounded jitter', () => {
    // Without jitter
    expect(computeDbRetryDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 })).toBe(1000);
    expect(computeDbRetryDelayMs(2, { baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 })).toBe(2000);
    expect(computeDbRetryDelayMs(3, { baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 })).toBe(4000);
    expect(computeDbRetryDelayMs(4, { baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 })).toBe(5000);

    // With deterministic jitter (+20% when random() === 1, -20% when random() === 0)
    expect(
      computeDbRetryDelayMs(1, {
        baseDelayMs: 1000,
        jitterRatio: 0.2,
        random: () => 1,
      }),
    ).toBe(1200);
    expect(
      computeDbRetryDelayMs(1, {
        baseDelayMs: 1000,
        jitterRatio: 0.2,
        random: () => 0,
      }),
    ).toBe(800);
  });

  it('uses the default prisma singleton when no custom client is passed', async () => {
    await connectWithRetry(3, 10);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});
