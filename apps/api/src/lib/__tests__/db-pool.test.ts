import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../generated/prisma/client', () => ({
  PrismaClient: vi.fn().mockImplementation((opts: unknown) => ({
    __opts: opts,
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn().mockImplementation((cfg: unknown) => cfg),
}));

import { resolvePoolConfig, buildPooledDatabaseUrl } from '../db-pool';
import {
  prisma,
  prismaRead,
  getReadClient,
  setReadTarget,
  getReadTarget,
} from '../prisma';

describe('Configure PostgreSQL Read Replicas & Connection Pooling (#527)', () => {
  beforeEach(() => {
    setReadTarget('REPLICA');
  });

  it('parses connection_limit, pool_timeout, and idle_timeout from DATABASE_URL and strips them from driver connectionString', () => {
    const rawUrl =
      'postgresql://postgres:secret@db.internal:5432/stellar_alerts?connection_limit=35&pool_timeout=15&idle_timeout=45&sslmode=require';
    const config = resolvePoolConfig(rawUrl);

    expect(config.max).toBe(35);
    expect(config.connectionTimeoutMillis).toBe(15000);
    expect(config.idleTimeoutMillis).toBe(45000);
    expect(config.connectionString).toBe(
      'postgresql://postgres:secret@db.internal:5432/stellar_alerts?sslmode=require',
    );
  });

  it('applies safe pool defaults (max=20, pool_timeout=10s, idle_timeout=30s) when query params are omitted or invalid', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = resolvePoolConfig(
      'postgresql://postgres:secret@localhost:5432/stellar_alerts?connection_limit=-5&pool_timeout=invalid',
    );

    expect(config.max).toBe(20);
    expect(config.connectionTimeoutMillis).toBe(10000);
    expect(config.idleTimeoutMillis).toBe(30000);
    warnSpy.mockRestore();
  });

  it('builds a pooled database URL with connection_limit and pool_timeout parameters', () => {
    const pooled = buildPooledDatabaseUrl(
      'postgresql://postgres:secret@localhost:5432/stellar_alerts',
      { connectionLimit: 25, poolTimeoutSeconds: 12 },
    );
    expect(pooled).toContain('connection_limit=25');
    expect(pooled).toContain('pool_timeout=12');
  });

  it('routes read queries to prismaRead when target is REPLICA and falls back to primary when switched to PRIMARY', () => {
    expect(getReadTarget()).toBe('REPLICA');
    expect(getReadClient()).toBe(prismaRead);

    setReadTarget('PRIMARY');
    expect(getReadTarget()).toBe('PRIMARY');
    expect(getReadClient()).toBe(prisma);
  });
});
