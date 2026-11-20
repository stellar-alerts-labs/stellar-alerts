import { describe, it, expect, vi } from 'vitest';
import {
  SignerWatcher,
  InMemorySignerSnapshotStore,
  RedisSignerSnapshotStore,
  buildSnapshot,
  diffSignerState,
  type SignerAccountState,
  type SignerFinding,
} from '../signer-watcher.service';

const ACCOUNT = 'GTREASURYACCOUNTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SIGNER_A = 'GSIGNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SIGNER_B = 'GSIGNERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function state(overrides: Partial<SignerAccountState> = {}): SignerAccountState {
  return {
    signers: [
      { key: ACCOUNT, weight: 1 },
      { key: SIGNER_A, weight: 2 },
      { key: SIGNER_B, weight: 2 },
    ],
    thresholds: { low: 1, medium: 2, high: 3 },
    masterWeight: 1,
    ...overrides,
  };
}

const snap = (s: SignerAccountState) => buildSnapshot(ACCOUNT, s, new Date('2026-01-01T00:00:00Z'));
const types = (findings: SignerFinding[]) => findings.map((f) => f.type);

describe('diffSignerState', () => {
  it('returns nothing when the state is identical', () => {
    expect(diffSignerState(snap(state()), snap(state()))).toEqual([]);
  });

  it('ignores signer ordering differences', () => {
    const reordered = state({ signers: [...state().signers].reverse() });
    expect(diffSignerState(snap(state()), snap(reordered))).toEqual([]);
  });

  it('detects an added signer', () => {
    const added = state({ signers: [...state().signers, { key: 'GNEWSIGNER', weight: 1 }] });
    const findings = diffSignerState(snap(state()), snap(added));
    expect(types(findings)).toEqual(['signer_added']);
    expect(findings[0]).toMatchObject({ signerKey: 'GNEWSIGNER', currentValue: 1, severity: 'warning' });
  });

  it('detects a removed signer as critical', () => {
    const removed = state({ signers: state().signers.filter((s) => s.key !== SIGNER_B) });
    const findings = diffSignerState(snap(state()), snap(removed));
    expect(types(findings)).toEqual(['signer_removed']);
    expect(findings[0]).toMatchObject({ signerKey: SIGNER_B, previousValue: 2, severity: 'critical' });
  });

  it('detects a signer weight change with old and new values', () => {
    const changed = state({
      signers: state().signers.map((s) => (s.key === SIGNER_A ? { ...s, weight: 5 } : s)),
    });
    const findings = diffSignerState(snap(state()), snap(changed));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: 'signer_weight_changed',
      signerKey: SIGNER_A,
      previousValue: 2,
      currentValue: 5,
    });
  });

  it('flags zeroing the master key as critical', () => {
    const zeroed = state({
      signers: state().signers.map((s) => (s.key === ACCOUNT ? { ...s, weight: 0 } : s)),
      masterWeight: 0,
    });
    const findings = diffSignerState(snap(state()), snap(zeroed));
    expect(types(findings)).toContain('master_key_disabled');
    expect(findings.find((f) => f.type === 'master_key_disabled')).toMatchObject({
      severity: 'critical',
      previousValue: 1,
      currentValue: 0,
    });
  });

  it('flags a master weight change that is not a full disable', () => {
    const before = snap(state({ masterWeight: 3, signers: [{ key: ACCOUNT, weight: 3 }, { key: SIGNER_A, weight: 2 }] }));
    const after = snap(state({ masterWeight: 1, signers: [{ key: ACCOUNT, weight: 1 }, { key: SIGNER_A, weight: 2 }] }));
    const finding = diffSignerState(before, after).find((f) => f.type === 'master_weight_changed');
    expect(finding).toMatchObject({ severity: 'critical', previousValue: 3, currentValue: 1 });
  });

  it.each([
    ['low', { low: 0, medium: 2, high: 3 }],
    ['medium', { low: 1, medium: 1, high: 3 }],
    ['high', { low: 1, medium: 2, high: 1 }],
  ] as const)('alerts when the %s threshold is lowered', (level, thresholds) => {
    const findings = diffSignerState(snap(state()), snap(state({ thresholds })));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: 'threshold_changed', thresholdLevel: level, severity: 'critical' });
  });

  it('treats a threshold increase as a warning', () => {
    const findings = diffSignerState(snap(state()), snap(state({ thresholds: { low: 1, medium: 2, high: 4 } })));
    expect(findings[0]).toMatchObject({ type: 'threshold_changed', thresholdLevel: 'high', severity: 'warning' });
  });

  it('reports every changed threshold level separately', () => {
    const findings = diffSignerState(snap(state()), snap(state({ thresholds: { low: 2, medium: 3, high: 4 } })));
    expect(findings.map((f) => f.thresholdLevel)).toEqual(['low', 'medium', 'high']);
  });

  it('flags lockout risk when remaining weight cannot meet the high threshold', () => {
    const lockedOut = state({
      signers: [
        { key: ACCOUNT, weight: 0 },
        { key: SIGNER_A, weight: 2 },
      ],
      masterWeight: 0,
    });
    const findings = diffSignerState(snap(state()), snap(lockedOut));
    expect(types(findings)).toEqual(expect.arrayContaining(['signer_removed', 'master_key_disabled', 'account_lockout_risk']));
  });

  it('does not re-flag a pre-existing lockout when nothing changed', () => {
    const lockedOut = state({ thresholds: { low: 1, medium: 2, high: 99 } });
    expect(diffSignerState(snap(lockedOut), snap(lockedOut))).toEqual([]);
  });
});

describe('SignerWatcher', () => {
  function makeWatcher(responses: Array<SignerAccountState | null>) {
    const queue = [...responses];
    const notifier = vi.fn();
    const watcher = new SignerWatcher({
      fetchAccount: async () => (queue.length ? queue.shift()! : null),
      notifier,
      store: new InMemorySignerSnapshotStore(),
    });
    return { watcher, notifier };
  }

  it('seeds a baseline on first sight without alerting', async () => {
    const { watcher, notifier } = makeWatcher([state()]);
    const result = await watcher.checkAccount(ACCOUNT);
    expect(result.status).toBe('seeded');
    expect(notifier).not.toHaveBeenCalled();
  });

  it('reports unchanged state silently', async () => {
    const { watcher, notifier } = makeWatcher([state(), state()]);
    await watcher.checkAccount(ACCOUNT);
    expect((await watcher.checkAccount(ACCOUNT)).status).toBe('unchanged');
    expect(notifier).not.toHaveBeenCalled();
  });

  it('notifies once per change and advances the baseline', async () => {
    const mutated = state({ thresholds: { low: 1, medium: 1, high: 1 } });
    const { watcher, notifier } = makeWatcher([state(), mutated, mutated]);
    await watcher.checkAccount(ACCOUNT);

    const changed = await watcher.checkAccount(ACCOUNT);
    expect(changed.status).toBe('changed');
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0][0]).toBe(ACCOUNT);

    const again = await watcher.checkAccount(ACCOUNT);
    expect(again.status).toBe('unchanged');
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('keeps the old baseline when the notifier fails so the change is re-alerted', async () => {
    const mutated = state({ masterWeight: 0, signers: state().signers.map((s) => (s.key === ACCOUNT ? { ...s, weight: 0 } : s)) });
    const queue = [state(), mutated, mutated];
    const notifier = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    const watcher = new SignerWatcher({ fetchAccount: async () => queue.shift()!, notifier });

    await watcher.checkAccount(ACCOUNT);
    await expect(watcher.checkAccount(ACCOUNT)).rejects.toThrow('down');
    const retry = await watcher.checkAccount(ACCOUNT);
    expect(retry.status).toBe('changed');
    expect(notifier).toHaveBeenCalledTimes(2);
  });

  it('skips accounts that cannot be loaded', async () => {
    const { watcher, notifier } = makeWatcher([null]);
    expect((await watcher.checkAccount(ACCOUNT)).status).toBe('skipped');
    expect(notifier).not.toHaveBeenCalled();
  });

  it('isolates per-account failures in checkAccounts', async () => {
    const watcher = new SignerWatcher({
      fetchAccount: async (id) => {
        if (id === 'GBAD') throw new Error('horizon down');
        return state();
      },
      notifier: vi.fn(),
    });
    const results = await watcher.checkAccounts(['GBAD', ACCOUNT]);
    expect(results.map((r) => r.status)).toEqual(['skipped', 'seeded']);
  });
});

describe('RedisSignerSnapshotStore', () => {
  it('round-trips snapshots and tolerates corrupt values', async () => {
    const data = new Map<string, string>();
    const store = new RedisSignerSnapshotStore({
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => void data.set(k, v),
      del: async (k) => void data.delete(k),
    });

    expect(await store.get(ACCOUNT)).toBeNull();
    const s = snap(state());
    await store.set(s);
    expect(await store.get(ACCOUNT)).toEqual(s);

    data.set('signer-watcher:snapshot:' + ACCOUNT, '{not json');
    expect(await store.get(ACCOUNT)).toBeNull();

    await store.delete(ACCOUNT);
    expect(data.size).toBe(0);
  });
});
