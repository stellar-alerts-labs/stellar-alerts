import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CausalRouter,
  RYOW_WATERMARK_TTL_SECONDS,
  compareLsn,
  createCausalReadProxy,
  createMemoryWatermarkStore,
  getCausalContext,
  parseLsn,
  withCausalContext,
  watermarkKey,
  type CausalRouterDeps,
} from '../prisma-causal-router';

function makeDeps(overrides: Partial<CausalRouterDeps> = {}): CausalRouterDeps & {
  getReplicaLsn: ReturnType<typeof vi.fn>;
  getPrimaryLsn: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const store = createMemoryWatermarkStore();
  return {
    get: store.get,
    set: vi.fn(store.set),
    getPrimaryLsn: vi.fn(async () => '0/16B3700'),
    getReplicaLsn: vi.fn(async () => '0/16B3748'),
    ...overrides,
  } as CausalRouterDeps & {
    getReplicaLsn: ReturnType<typeof vi.fn>;
    getPrimaryLsn: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
}

describe('LSN arithmetic', () => {
  it('parses the two hex words numerically', () => {
    expect(parseLsn('0/16B3748')).toEqual({ log: 0n, offset: 0x16b3748n });
    expect(parseLsn('  A/10  ')).toEqual({ log: 10n, offset: 16n });
  });

  it('compares offsets within the same log word', () => {
    expect(compareLsn('0/16B3748', '0/16B3700')).toBe(1);
    expect(compareLsn('0/16B3700', '0/16B3748')).toBe(-1);
  });

  it('compares the log word before the offset', () => {
    expect(compareLsn('1/1', '0/FFFFFFFF')).toBe(1);
    expect(compareLsn('0/FFFFFFFF', '1/0')).toBe(-1);
  });

  it('treats equal LSNs as equal regardless of case', () => {
    expect(compareLsn('0/16B3748', '0/16b3748')).toBe(0);
  });

  it('rejects malformed LSNs so callers can fail closed', () => {
    expect(() => parseLsn('not-an-lsn')).toThrow(TypeError);
    expect(() => parseLsn('0/XYZ')).toThrow(TypeError);
    expect(() => compareLsn('0/16B3748', '')).toThrow(TypeError);
  });
});

describe('watermark lifecycle', () => {
  it('records a mutation with a 10 second TTL at ryow:{userId}', async () => {
    const deps = makeDeps();
    const router = new CausalRouter(deps);

    const lsn = await router.recordMutation('user-1', 'tenant-1');

    expect(lsn).toBe('0/16B3700');
    expect(deps.getPrimaryLsn).toHaveBeenCalledTimes(1);
    expect(deps.set).toHaveBeenCalledWith('user-1', '0/16B3700', RYOW_WATERMARK_TTL_SECONDS);
    expect(RYOW_WATERMARK_TTL_SECONDS).toBe(10);
    expect(watermarkKey('user-1')).toBe('ryow:user-1');
  });

  it('expires a watermark after the TTL using an injected clock', async () => {
    let now = 1_000;
    const store = createMemoryWatermarkStore(() => now);
    const deps = makeDeps({ get: store.get, set: store.set });
    const router = new CausalRouter(deps);

    await router.recordMutation('user-1');
    now += 9_999;
    expect(await router.getWatermark('user-1')).toBe('0/16B3700');

    now += 1;
    expect(await router.getWatermark('user-1')).toBeNull();
    // An expired watermark behaves like no watermark: no LSN probe at all.
    expect(await router.resolveReadTarget('user-1')).toBe('REPLICA');
    expect(deps.getReplicaLsn).not.toHaveBeenCalled();
  });
});

describe('primary/replica selection', () => {
  it('uses the replica with no extra LSN query when no watermark exists', async () => {
    const deps = makeDeps();
    const router = new CausalRouter(deps);

    expect(await router.resolveReadTarget('user-1')).toBe('REPLICA');
    expect(deps.getReplicaLsn).not.toHaveBeenCalled();
  });

  it('uses the replica once it has replayed past the watermark', async () => {
    const deps = makeDeps({
      getReplicaLsn: vi.fn(async () => '0/16B3748'),
    });
    const store = createMemoryWatermarkStore();
    await store.set('user-1', '0/16B3700', 10);
    const router = new CausalRouter({ ...deps, get: store.get });

    expect(await router.resolveReadTarget('user-1')).toBe('REPLICA');
    expect(deps.getReplicaLsn).toHaveBeenCalledTimes(1);
  });

  it('uses the primary when the replica lags the watermark', async () => {
    const deps = makeDeps({
      getReplicaLsn: vi.fn(async () => '0/16B3700'),
    });
    const store = createMemoryWatermarkStore();
    await store.set('user-1', '0/16B3748', 10);
    const router = new CausalRouter({ ...deps, get: store.get });

    expect(await router.resolveReadTarget('user-1')).toBe('PRIMARY');
  });

  it('fails closed to the primary on malformed or failing LSN probes', async () => {
    const store = createMemoryWatermarkStore();
    await store.set('user-1', '0/16B3700', 10);

    const badLsn = makeDeps({ getReplicaLsn: vi.fn(async () => null as unknown as string) });
    expect(await new CausalRouter({ ...badLsn, get: store.get }).resolveReadTarget('user-1')).toBe('PRIMARY');

    const failingProbe = makeDeps({
      getReplicaLsn: vi.fn(async () => {
        throw new Error('replica unavailable');
      }),
    });
    expect(await new CausalRouter({ ...failingProbe, get: store.get }).resolveReadTarget('user-1')).toBe('PRIMARY');
  });
});

describe('causal read proxy', () => {
  const primary = {
    payment: {
      findMany: vi.fn(async () => ['primary']),
      create: vi.fn(async () => 'created'),
    },
  };
  const replica = {
    payment: {
      findMany: vi.fn(async () => ['replica']),
      create: vi.fn(async () => 'replica-created'),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends reads to the replica without an LSN probe when no watermark is set', async () => {
    const deps = makeDeps();
    const router = new CausalRouter(deps);
    const client = createCausalReadProxy('user-1', { primary, replica }, router);

    expect(await client.payment.findMany()).toEqual(['replica']);
    expect(deps.getReplicaLsn).not.toHaveBeenCalled();
  });

  it('sends reads to the primary when the replica is behind', async () => {
    const deps = makeDeps({ getReplicaLsn: vi.fn(async () => '0/1') });
    const store = createMemoryWatermarkStore();
    await store.set('user-1', '0/16B3748', 10);
    const router = new CausalRouter({ ...deps, get: store.get });
    const client = createCausalReadProxy('user-1', { primary, replica }, router);

    expect(await client.payment.findMany()).toEqual(['primary']);
  });

  it('leaves mutation methods on the wrapped read client untouched', async () => {
    const deps = makeDeps();
    const router = new CausalRouter(deps);
    const client = createCausalReadProxy('user-1', { primary, replica }, router);

    expect(await client.payment.create()).toBe('replica-created');
  });
});

describe('causal context', () => {
  it('runs a callback with a user/tenant context and restores it afterwards', async () => {
    expect(getCausalContext()).toBeUndefined();
    const seen = await withCausalContext({ userId: 'user-7', tenantId: 'tenant-3' }, async () => {
      expect(getCausalContext()).toEqual({ userId: 'user-7', tenantId: 'tenant-3' });
      return 'done';
    });
    expect(seen).toBe('done');
    expect(getCausalContext()).toBeUndefined();
  });
});
