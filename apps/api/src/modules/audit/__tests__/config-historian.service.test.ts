import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  ConfigAuditHistorian,
  diffJson,
  InMemoryAuditStore,
  jsonEquals,
  type AuditEntry,
  type Json,
} from '../config-historian.service';

function historian(start = '2026-01-01T00:00:00Z') {
  let now = new Date(start).getTime();
  const store = new InMemoryAuditStore();
  return {
    store,
    historian: new ConfigAuditHistorian(store, () => new Date(now)),
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const RULE = 'RULE' as const;

describe('diffJson', () => {
  it('is empty for equal values', () => {
    expect(diffJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toEqual([]);
  });

  it('is a single replace for one changed field', () => {
    expect(diffJson({ threshold: 100, name: 'r' }, { threshold: 250, name: 'r' })).toEqual([
      { op: 'replace', path: '/threshold', value: 250 },
    ]);
  });

  it('adds and removes keys', () => {
    expect(diffJson({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { op: 'remove', path: '/b' },
      { op: 'add', path: '/c', value: 3 },
    ]);
  });

  it('recurses into nested objects', () => {
    expect(diffJson({ cfg: { retry: { max: 3 } } }, { cfg: { retry: { max: 5 } } })).toEqual([
      { op: 'replace', path: '/cfg/retry/max', value: 5 },
    ]);
  });

  it('diffs arrays index by index, appends at the end and removes from the end', () => {
    expect(diffJson({ l: [1, 2, 3] }, { l: [1, 9] })).toEqual([
      { op: 'replace', path: '/l/1', value: 9 },
      { op: 'remove', path: '/l/2' },
    ]);
    expect(diffJson({ l: [1] }, { l: [1, 2, 3] })).toEqual([
      { op: 'add', path: '/l/1', value: 2 },
      { op: 'add', path: '/l/2', value: 3 },
    ]);
  });

  it('replaces when the type changes', () => {
    expect(diffJson({ v: [1] }, { v: { a: 1 } })).toEqual([{ op: 'replace', path: '/v', value: { a: 1 } }]);
    expect(diffJson({ v: null }, { v: 'x' })).toEqual([{ op: 'replace', path: '/v', value: 'x' }]);
  });

  it('escapes ~ and / in keys per RFC 6901', () => {
    expect(diffJson({ 'a/b': 1, 'c~d': 1 }, { 'a/b': 2, 'c~d': 2 })).toEqual([
      { op: 'replace', path: '/a~1b', value: 2 },
      { op: 'replace', path: '/c~0d', value: 2 },
    ]);
  });

  it('always produces a patch that turns the old value into the new one', () => {
    const cases: [Json, Json][] = [
      [{ a: 1 }, { a: 1, b: { c: [1, 2] } }],
      [{ l: [1, 2, 3, 4] }, { l: [1] }],
      [{ l: [{ x: 1 }, { x: 2 }] }, { l: [{ x: 1 }, { x: 3 }, { x: 4 }] }],
      [{ 'k/1': { 'm~n': true } }, { 'k/1': { 'm~n': false } }],
      [{ a: [] }, { a: [[1], [2]] }],
      [{ a: 1, b: 2, c: 3 }, {}],
    ];
    for (const [from, to] of cases) {
      expect(jsonEquals(applyPatch(from, diffJson(from, to)), to)).toBe(true);
    }
  });
});

describe('applyPatch', () => {
  it('does not mutate its input', () => {
    const input = { a: { b: 1 } };
    const output = applyPatch(input, [{ op: 'replace', path: '/a/b', value: 2 }]);
    expect(input).toEqual({ a: { b: 1 } });
    expect(output).toEqual({ a: { b: 2 } });
  });

  it('replaces the whole document at the root path', () => {
    expect(applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: { z: 1 } }])).toEqual({ z: 1 });
  });

  it.each([
    [{ op: 'replace', path: '/missing', value: 1 }],
    [{ op: 'remove', path: '/missing' }],
    [{ op: 'replace', path: '/a/b/c', value: 1 }],
    [{ op: 'remove', path: '' }],
    [{ op: 'add', path: '/l/9', value: 1 }],
  ] as const)('throws for an operation that does not fit the document: %j', (operation) => {
    expect(() => applyPatch({ a: 1, l: [1] }, [operation])).toThrow();
  });
});

describe('recording changes', () => {
  it('records a create, an update and a delete with old value, new value, patch, actor and ledger', async () => {
    const { historian: h, tick } = historian();

    const created = await h.record({
      entityType: RULE,
      entityId: 'r1',
      action: 'CREATE',
      oldValue: null,
      newValue: { threshold: 100, enabled: true },
      actorId: 'u1',
      ledgerSeq: 500,
    });
    tick(1_000);
    const updated = await h.record({
      entityType: RULE,
      entityId: 'r1',
      action: 'UPDATE',
      oldValue: { threshold: 100, enabled: true },
      newValue: { threshold: 250, enabled: true },
      actorId: 'u2',
      ledgerSeq: 510,
    });
    tick(1_000);
    const deleted = await h.record({
      entityType: RULE,
      entityId: 'r1',
      action: 'DELETE',
      oldValue: { threshold: 250, enabled: true },
      newValue: null,
      actorId: 'u1',
    });

    expect(created).toMatchObject({
      version: 1,
      action: 'CREATE',
      oldValue: null,
      newValue: { threshold: 100, enabled: true },
      actorId: 'u1',
      ledgerSeq: 500,
      recordedAt: '2026-01-01T00:00:00.000Z',
      patch: [{ op: 'replace', path: '', value: { threshold: 100, enabled: true } }],
    });
    expect(updated).toMatchObject({
      version: 2,
      patch: [{ op: 'replace', path: '/threshold', value: 250 }],
      actorId: 'u2',
      ledgerSeq: 510,
    });
    expect(deleted).toMatchObject({ version: 3, action: 'DELETE', newValue: null, ledgerSeq: null });
  });

  it('audits wallets, rules and webhooks independently, even with the same id', async () => {
    const { historian: h } = historian();
    for (const entityType of ['WALLET', 'RULE', 'WEBHOOK'] as const) {
      await h.record({ entityType, entityId: 'same', action: 'CREATE', oldValue: null, newValue: { kind: entityType } });
    }

    expect((await h.history('WALLET', 'same')).map((e) => e.newValue)).toEqual([{ kind: 'WALLET' }]);
    expect((await h.history('WEBHOOK', 'same')).map((e) => e.newValue)).toEqual([{ kind: 'WEBHOOK' }]);
  });

  it('skips an update that changes nothing', async () => {
    const { historian: h } = historian();
    await h.record({ entityType: RULE, entityId: 'r1', action: 'CREATE', oldValue: null, newValue: { a: 1 } });

    const entry = await h.record({ entityType: RULE, entityId: 'r1', action: 'UPDATE', oldValue: { a: 1 }, newValue: { a: 1 } });

    expect(entry).toBeNull();
    expect(await h.history(RULE, 'r1')).toHaveLength(1);
  });

  it('stores plain JSON: undefined properties are dropped and the input is not retained', async () => {
    const { historian: h } = historian();
    const source = { a: 1, gone: undefined, nested: { b: 2 } };
    const entry = await h.record({ entityType: RULE, entityId: 'r1', action: 'CREATE', oldValue: null, newValue: source });

    source.nested.b = 99;

    expect(entry?.newValue).toEqual({ a: 1, nested: { b: 2 } });
  });

  it.each([
    ['CREATE with an old value', { action: 'CREATE', oldValue: { a: 1 }, newValue: { a: 2 } }],
    ['CREATE without a new value', { action: 'CREATE', oldValue: null, newValue: null }],
    ['UPDATE without an old value', { action: 'UPDATE', oldValue: null, newValue: { a: 1 } }],
    ['UPDATE without a new value', { action: 'UPDATE', oldValue: { a: 1 }, newValue: null }],
    ['DELETE with a new value', { action: 'DELETE', oldValue: { a: 1 }, newValue: { a: 2 } }],
    ['DELETE without an old value', { action: 'DELETE', oldValue: null, newValue: null }],
  ] as const)('rejects %s', async (_label, input) => {
    const { historian: h } = historian();
    await expect(h.record({ entityType: RULE, entityId: 'r1', ...input })).rejects.toThrow();
  });

  it('rejects creating an entity that exists, and changing one that does not or was deleted', async () => {
    const { historian: h } = historian();
    await expect(
      h.record({ entityType: RULE, entityId: 'r1', action: 'UPDATE', oldValue: { a: 1 }, newValue: { a: 2 } }),
    ).rejects.toThrow(/does not exist/);

    await h.record({ entityType: RULE, entityId: 'r1', action: 'CREATE', oldValue: null, newValue: { a: 1 } });
    await expect(
      h.record({ entityType: RULE, entityId: 'r1', action: 'CREATE', oldValue: null, newValue: { a: 1 } }),
    ).rejects.toThrow(/already exists/);

    await h.record({ entityType: RULE, entityId: 'r1', action: 'DELETE', oldValue: { a: 1 }, newValue: null });
    await expect(
      h.record({ entityType: RULE, entityId: 'r1', action: 'UPDATE', oldValue: { a: 1 }, newValue: { a: 2 } }),
    ).rejects.toThrow(/does not exist/);
  });

  it('allows an entity to be created again after it was deleted, continuing the version count', async () => {
    const { historian: h, tick } = historian();
    await h.record({ entityType: RULE, entityId: 'r1', action: 'CREATE', oldValue: null, newValue: { a: 1 } });
    tick(1);
    await h.record({ entityType: RULE, entityId: 'r1', action: 'DELETE', oldValue: { a: 1 }, newValue: null });
    tick(1);

    const again = await h.record({ entityType: RULE, entityId: 'r1', action: 'CREATE', oldValue: null, newValue: { a: 9 } });

    expect(again?.version).toBe(3);
  });

  it('rejects entries that go back in time and invalid timestamps', async () => {
    const { historian: h } = historian('2026-06-01T00:00:00Z');
    await h.record({ entityType: RULE, entityId: 'r1', action: 'CREATE', oldValue: null, newValue: { a: 1 } });

    await expect(
      h.record({ entityType: RULE, entityId: 'r1', action: 'UPDATE', oldValue: { a: 1 }, newValue: { a: 2 }, at: '2026-05-01T00:00:00Z' }),
    ).rejects.toThrow(/back in time/);
    await expect(
      h.record({ entityType: RULE, entityId: 'r1', action: 'UPDATE', oldValue: { a: 1 }, newValue: { a: 2 }, at: 'not a date' }),
    ).rejects.toThrow(/Invalid/);
  });
});

describe('the store is append-only', () => {
  it('has no way to change or remove an entry', () => {
    const store = new InMemoryAuditStore() as unknown as Record<string, unknown>;
    expect(Object.keys(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(store))).sort()).toEqual([
      'append',
      'constructor',
      'list',
    ]);
  });

  it('freezes stored entries so a caller cannot edit history in place', async () => {
    const { historian: h } = historian();
    await h.record({ entityType: RULE, entityId: 'r1', action: 'CREATE', oldValue: null, newValue: { a: { b: 1 } } });
    const [entry] = await h.history(RULE, 'r1');

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry.newValue as { a: { b: number } }).a.b = 2;
    }).toThrow();
    expect(() => {
      (entry as { version: number }).version = 9;
    }).toThrow();
  });

  it('rejects an append that skips or repeats a version', async () => {
    const store = new InMemoryAuditStore();
    const entry: AuditEntry = {
      entityType: RULE,
      entityId: 'r1',
      version: 2,
      action: 'CREATE',
      oldValue: null,
      newValue: { a: 1 },
      patch: [],
      actorId: null,
      ledgerSeq: null,
      recordedAt: '2026-01-01T00:00:00.000Z',
    };
    await expect(store.append(entry)).rejects.toThrow(/version conflict/);
    await store.append({ ...entry, version: 1 });
    await expect(store.append({ ...entry, version: 1 })).rejects.toThrow(/version conflict/);
  });
});

describe('reconstructStateAt', () => {
  /** Five threshold edits, one per hour, starting from creation at 00:00. */
  async function fiveEdits() {
    const ctx = historian('2026-03-01T00:00:00Z');
    const thresholds = [100, 150, 175, 400, 90, 1000];
    let previous: Json | null = null;
    for (let i = 0; i < thresholds.length; i += 1) {
      const next = { name: 'big-payment', threshold: thresholds[i], channels: ['email'], enabled: true };
      await ctx.historian.record({
        entityType: RULE,
        entityId: 'rule-1',
        action: i === 0 ? 'CREATE' : 'UPDATE',
        oldValue: previous,
        newValue: next,
        actorId: `user-${i}`,
      });
      previous = next;
      ctx.tick(60 * 60 * 1000);
    }
    return { ...ctx, thresholds };
  }

  it('rebuilds the exact rule at an instant between each of five threshold edits', async () => {
    const { historian: h, thresholds } = await fiveEdits();

    for (let i = 0; i < thresholds.length; i += 1) {
      const at = new Date(Date.UTC(2026, 2, 1, i, 30)); // half an hour after edit i
      const result = await h.reconstructStateAt(RULE, 'rule-1', at);

      expect(result).toEqual({
        exists: true,
        version: i + 1,
        state: { name: 'big-payment', threshold: thresholds[i], channels: ['email'], enabled: true },
      });
    }
  });

  it('includes a change recorded at exactly the requested instant', async () => {
    const { historian: h } = await fiveEdits();
    const result = await h.reconstructStateAt(RULE, 'rule-1', '2026-03-01T03:00:00.000Z');
    expect((result?.state as { threshold: number }).threshold).toBe(400);
  });

  it('returns null before the entity was created', async () => {
    const { historian: h } = await fiveEdits();
    expect(await h.reconstructStateAt(RULE, 'rule-1', '2026-02-28T23:59:59Z')).toBeNull();
    expect(await h.reconstructStateAt(RULE, 'never-existed', '2030-01-01T00:00:00Z')).toBeNull();
  });

  it('reports the final state for a time after the last edit', async () => {
    const { historian: h } = await fiveEdits();
    const result = await h.reconstructStateAt(RULE, 'rule-1', '2099-01-01T00:00:00Z');
    expect(result).toMatchObject({ version: 6, exists: true });
    expect((result?.state as { threshold: number }).threshold).toBe(1000);
  });

  it('reports a deleted entity as not existing, and as existing again before the delete', async () => {
    const { historian: h, tick } = historian('2026-03-01T00:00:00Z');
    await h.record({ entityType: 'WEBHOOK', entityId: 'w1', action: 'CREATE', oldValue: null, newValue: { url: 'https://a.example' } });
    tick(3_600_000);
    await h.record({ entityType: 'WEBHOOK', entityId: 'w1', action: 'DELETE', oldValue: { url: 'https://a.example' }, newValue: null });

    expect(await h.reconstructStateAt('WEBHOOK', 'w1', '2026-03-01T00:30:00Z')).toMatchObject({
      exists: true,
      state: { url: 'https://a.example' },
    });
    expect(await h.reconstructStateAt('WEBHOOK', 'w1', '2026-03-01T02:00:00Z')).toEqual({
      exists: false,
      state: null,
      version: 2,
    });
  });

  it('shows the webhook URL that was live when an old alert fired, not the current one', async () => {
    const { historian: h, tick } = historian('2026-03-01T00:00:00Z');
    await h.record({ entityType: 'WEBHOOK', entityId: 'w1', action: 'CREATE', oldValue: null, newValue: { url: 'https://old.example', secret: 's1' } });
    tick(86_400_000);
    await h.record({ entityType: 'WEBHOOK', entityId: 'w1', action: 'UPDATE', oldValue: { url: 'https://old.example', secret: 's1' }, newValue: { url: 'https://new.example', secret: 's1' } });

    const then = await h.reconstructStateAt('WEBHOOK', 'w1', '2026-03-01T12:00:00Z');
    const now = await h.reconstructStateAt('WEBHOOK', 'w1', '2026-03-03T00:00:00Z');

    expect((then?.state as { url: string }).url).toBe('https://old.example');
    expect((now?.state as { url: string }).url).toBe('https://new.example');
  });

  it('survives the entity being created again after a delete', async () => {
    const { historian: h, tick } = historian('2026-03-01T00:00:00Z');
    await h.record({ entityType: RULE, entityId: 'r', action: 'CREATE', oldValue: null, newValue: { v: 1 } });
    tick(1000);
    await h.record({ entityType: RULE, entityId: 'r', action: 'DELETE', oldValue: { v: 1 }, newValue: null });
    tick(1000);
    await h.record({ entityType: RULE, entityId: 'r', action: 'CREATE', oldValue: null, newValue: { v: 2 } });

    expect((await h.reconstructStateAt(RULE, 'r', '2026-03-01T00:00:01.500Z'))?.exists).toBe(false);
    expect((await h.reconstructStateAt(RULE, 'r', '2026-03-01T00:00:05Z'))?.state).toEqual({ v: 2 });
  });

  it('rejects an invalid timestamp', async () => {
    const { historian: h } = historian();
    await expect(h.reconstructStateAt(RULE, 'r', 'tomorrow-ish')).rejects.toThrow(/Invalid/);
  });
});

describe('verify', () => {
  it('passes for an untouched trail', async () => {
    const { historian: h } = historian();
    await h.record({ entityType: RULE, entityId: 'r', action: 'CREATE', oldValue: null, newValue: { a: 1, l: [1] } });
    await h.record({ entityType: RULE, entityId: 'r', action: 'UPDATE', oldValue: { a: 1, l: [1] }, newValue: { a: 2, l: [1, 2] } });

    expect(await h.verify(RULE, 'r')).toEqual({ ok: true, badVersions: [] });
  });

  it('flags a version whose patch no longer matches its recorded values', async () => {
    const store = {
      entries: [] as AuditEntry[],
      async append(entry: AuditEntry) {
        this.entries.push(entry);
      },
      async list() {
        return this.entries;
      },
    };
    const h = new ConfigAuditHistorian(store);
    await h.record({ entityType: RULE, entityId: 'r', action: 'CREATE', oldValue: null, newValue: { a: 1 }, at: '2026-01-01T00:00:00Z' });
    await h.record({ entityType: RULE, entityId: 'r', action: 'UPDATE', oldValue: { a: 1 }, newValue: { a: 2 }, at: '2026-01-02T00:00:00Z' });
    store.entries[1] = { ...store.entries[1], patch: [{ op: 'replace', path: '/a', value: 999 }] };

    expect(await h.verify(RULE, 'r')).toEqual({ ok: false, badVersions: [2] });
  });
});
