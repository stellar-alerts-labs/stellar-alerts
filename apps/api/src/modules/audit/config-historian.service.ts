/**
 * Point-in-time configuration audit trail (#992).
 *
 * Every create, update and delete of a wallet, rule or webhook is appended as an immutable entry
 * holding the old value, the new value and the minimal RFC 6902 JSON Patch between them. The state
 * of any entity at any past timestamp is rebuilt by replaying its patches, so "what rule was live
 * when this alert did or did not fire" has an exact answer.
 *
 * It is pure logic over an injected append-only store. A Prisma-backed store and the hooks that
 * call `record` from the wallet, rule and webhook services are separate steps that need a schema
 * migration.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type AuditEntityType = 'WALLET' | 'RULE' | 'WEBHOOK';
export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

export type JsonPatchOperation =
  | { op: 'add'; path: string; value: Json }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: Json };

export interface AuditEntry {
  entityType: AuditEntityType;
  entityId: string;
  /** 1 for the creation, then +1 per change. Gapless per entity. */
  version: number;
  action: AuditAction;
  oldValue: Json | null;
  newValue: Json | null;
  /** The patch that turns `oldValue` into `newValue`. A root replace (`path: ""`) for create/delete. */
  patch: JsonPatchOperation[];
  actorId: string | null;
  ledgerSeq: number | null;
  /** UTC instant the change was recorded, as an ISO 8601 string. */
  recordedAt: string;
}

export interface RecordChangeInput {
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  oldValue: unknown;
  newValue: unknown;
  actorId?: string | null;
  ledgerSeq?: number | null;
  /** Defaults to the historian's clock. */
  at?: Date | string;
}

export interface AuditStore {
  /** Appends an entry. There is deliberately no update or delete. */
  append(entry: AuditEntry): Promise<void>;
  /** All entries for an entity, oldest first. */
  list(entityType: AuditEntityType, entityId: string): Promise<readonly AuditEntry[]>;
}

export interface ReconstructedState {
  /** `false` when the entity had been deleted at that time. */
  exists: boolean;
  state: Json | null;
  /** Version of the last entry applied. */
  version: number;
}

// ── JSON helpers ─────────────────────────────────────────────────────────────────────────────

function isObject(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonEquals(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEquals(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && jsonEquals(a[k], b[k]));
  }
  return false;
}

/** Copies a value through JSON, so only plain JSON is stored (`undefined` properties are dropped). */
export function toJson(value: unknown): Json {
  if (value === undefined) throw new Error('Cannot audit an undefined value');
  return JSON.parse(JSON.stringify(value)) as Json;
}

const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapePointer = (key: string) => key.replace(/~1/g, '/').replace(/~0/g, '~');

// ── RFC 6902 diff / apply ────────────────────────────────────────────────────────────────────

/**
 * The minimal patch that turns `from` into `to`. Objects are compared key by key and arrays index
 * by index, so a one-field change is a single `replace`. Equal values give an empty patch.
 */
export function diffJson(from: Json, to: Json, path = ''): JsonPatchOperation[] {
  if (jsonEquals(from, to)) return [];

  if (isObject(from) && isObject(to)) {
    const ops: JsonPatchOperation[] = [];
    for (const key of Object.keys(from)) {
      if (!(key in to)) ops.push({ op: 'remove', path: `${path}/${escapePointer(key)}` });
    }
    for (const key of Object.keys(to)) {
      const child = `${path}/${escapePointer(key)}`;
      if (!(key in from)) ops.push({ op: 'add', path: child, value: to[key] });
      else ops.push(...diffJson(from[key], to[key], child));
    }
    return ops;
  }

  if (Array.isArray(from) && Array.isArray(to)) {
    const ops: JsonPatchOperation[] = [];
    const common = Math.min(from.length, to.length);
    for (let i = 0; i < common; i += 1) ops.push(...diffJson(from[i], to[i], `${path}/${i}`));
    for (let i = common; i < to.length; i += 1) ops.push({ op: 'add', path: `${path}/${i}`, value: to[i] });
    // Remove from the end so earlier indexes stay valid while the patch is applied in order.
    for (let i = from.length - 1; i >= common; i -= 1) ops.push({ op: 'remove', path: `${path}/${i}` });
    return ops;
  }

  return [{ op: 'replace', path, value: to }];
}

function clone(value: Json): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/**
 * Applies a patch made of `add`, `remove` and `replace` operations to a copy of `document`.
 * @throws if an operation points at something that does not exist.
 */
export function applyPatch(document: Json, patch: readonly JsonPatchOperation[]): Json {
  let doc = clone(document);

  for (const operation of patch) {
    if (operation.path === '') {
      if (operation.op === 'remove') throw new Error('Cannot remove the document root');
      doc = clone(operation.value);
      continue;
    }

    const segments = operation.path.slice(1).split('/').map(unescapePointer);
    const last = segments.pop() as string;
    let parent: Json = doc;
    for (const segment of segments) {
      const next: Json | undefined = Array.isArray(parent)
        ? parent[Number(segment)]
        : isObject(parent)
          ? parent[segment]
          : undefined;
      if (next === undefined) throw new Error(`Patch path not found: ${operation.path}`);
      parent = next;
    }

    if (Array.isArray(parent)) {
      const index = last === '-' ? parent.length : Number(last);
      if (!Number.isInteger(index) || index < 0) throw new Error(`Bad array index in ${operation.path}`);
      if (operation.op === 'add') {
        if (index > parent.length) throw new Error(`Array index out of range: ${operation.path}`);
        parent.splice(index, 0, clone(operation.value));
      } else {
        if (index >= parent.length) throw new Error(`Array index out of range: ${operation.path}`);
        if (operation.op === 'remove') parent.splice(index, 1);
        else parent[index] = clone(operation.value);
      }
    } else if (isObject(parent)) {
      if (operation.op !== 'add' && !(last in parent)) throw new Error(`Patch path not found: ${operation.path}`);
      if (operation.op === 'remove') delete parent[last];
      else parent[last] = clone(operation.value);
    } else {
      throw new Error(`Patch path not found: ${operation.path}`);
    }
  }

  return doc;
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** An in-memory append-only store: entries are frozen and versions must be gapless. */
export class InMemoryAuditStore implements AuditStore {
  private readonly entries = new Map<string, AuditEntry[]>();

  async append(entry: AuditEntry): Promise<void> {
    const key = `${entry.entityType}:${entry.entityId}`;
    const existing = this.entries.get(key) ?? [];
    if (entry.version !== existing.length + 1) {
      throw new Error(`Audit version conflict for ${key}: expected ${existing.length + 1}, got ${entry.version}`);
    }
    this.entries.set(key, [...existing, deepFreeze(structuredClone(entry))]);
  }

  async list(entityType: AuditEntityType, entityId: string): Promise<readonly AuditEntry[]> {
    return this.entries.get(`${entityType}:${entityId}`) ?? [];
  }
}

// ── Historian ────────────────────────────────────────────────────────────────────────────────

export class ConfigAuditHistorian {
  constructor(
    private readonly store: AuditStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Appends one audit entry. Returns `null`, appending nothing, for an update that changes nothing.
   * @throws if the action does not fit the values (create needs no old value, delete needs no new
   *   one, update needs both), or the timestamp is earlier than the entity's last entry.
   */
  async record(input: RecordChangeInput): Promise<AuditEntry | null> {
    const oldValue = input.oldValue == null ? null : toJson(input.oldValue);
    const newValue = input.newValue == null ? null : toJson(input.newValue);

    if (input.action === 'CREATE' && (oldValue !== null || newValue === null)) {
      throw new Error('CREATE needs a new value and no old value');
    }
    if (input.action === 'UPDATE' && (oldValue === null || newValue === null)) {
      throw new Error('UPDATE needs both an old and a new value');
    }
    if (input.action === 'DELETE' && (oldValue === null || newValue !== null)) {
      throw new Error('DELETE needs an old value and no new value');
    }

    const history = await this.store.list(input.entityType, input.entityId);
    const last = history[history.length - 1];
    const at = new Date(input.at ?? this.clock());
    if (Number.isNaN(at.getTime())) throw new Error('Invalid audit timestamp');
    if (last && at.getTime() < new Date(last.recordedAt).getTime()) {
      throw new Error('Audit entries must not go back in time');
    }

    // The first entry must create the entity; after a delete only a create may follow.
    const live = last ? last.action !== 'DELETE' : false;
    if (input.action === 'CREATE' && live) throw new Error('Entity already exists');
    if (input.action !== 'CREATE' && !live) throw new Error('Entity does not exist');

    const patch =
      oldValue === null || newValue === null
        ? ([{ op: 'replace', path: '', value: newValue }] as JsonPatchOperation[])
        : diffJson(oldValue, newValue);
    if (input.action === 'UPDATE' && patch.length === 0) return null;

    const entry: AuditEntry = {
      entityType: input.entityType,
      entityId: input.entityId,
      version: (last?.version ?? 0) + 1,
      action: input.action,
      oldValue,
      newValue,
      patch,
      actorId: input.actorId ?? null,
      ledgerSeq: input.ledgerSeq ?? null,
      recordedAt: at.toISOString(),
    };
    await this.store.append(entry);
    return entry;
  }

  /** The full change history of an entity, oldest first. */
  async history(entityType: AuditEntityType, entityId: string): Promise<readonly AuditEntry[]> {
    return this.store.list(entityType, entityId);
  }

  /**
   * The exact state of an entity at a UTC instant, rebuilt by replaying patches up to and including
   * that instant. Returns `null` if the entity did not exist yet.
   */
  async reconstructStateAt(
    entityType: AuditEntityType,
    entityId: string,
    at: Date | string,
  ): Promise<ReconstructedState | null> {
    const instant = new Date(at).getTime();
    if (Number.isNaN(instant)) throw new Error('Invalid timestamp');

    let state: Json | null = null;
    let version = 0;
    for (const entry of await this.store.list(entityType, entityId)) {
      if (new Date(entry.recordedAt).getTime() > instant) break;
      state = entry.action === 'DELETE' ? null : applyPatch(state ?? {}, entry.patch);
      version = entry.version;
    }

    if (version === 0) return null;
    return { exists: state !== null, state, version };
  }

  /**
   * Checks an entity's trail for tampering: replaying the patches must reproduce each entry's
   * recorded old and new value. Returns the versions that do not.
   */
  async verify(entityType: AuditEntityType, entityId: string): Promise<{ ok: boolean; badVersions: number[] }> {
    const badVersions: number[] = [];
    let state: Json | null = null;
    for (const entry of await this.store.list(entityType, entityId)) {
      try {
        const next: Json | null = entry.action === 'DELETE' ? null : applyPatch(state ?? {}, entry.patch);
        const consistent =
          (entry.oldValue === null ? state === null : state !== null && jsonEquals(state, entry.oldValue)) &&
          (entry.newValue === null ? next === null : next !== null && jsonEquals(next, entry.newValue));
        if (!consistent) badVersions.push(entry.version);
        state = next;
      } catch {
        badVersions.push(entry.version);
      }
    }
    return { ok: badVersions.length === 0, badVersions };
  }
}
