import { describe, it, expect, vi } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import {
  ANCHOR_EVENT_TYPE,
  OnChainNotaryService,
  StellarManageDataPublisher,
  hourBounds,
  hourKeyFor,
  type AuditAnchorStore,
  type NotaryLogRecord,
  type StellarPublisher,
  type StoredAnchor,
} from '../onchain-notary.service';
import { buildMerkleTree, verifyInclusionProof } from '../merkle-tree';

const HOUR = new Date('2026-11-24T14:37:00.000Z');

function byTime(a: NotaryLogRecord, b: NotaryLogRecord): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

class MemoryAnchorStore implements AuditAnchorStore {
  logs: NotaryLogRecord[] = [];
  alerts: NotaryLogRecord[] = [];
  anchors = new Map<string, StoredAnchor>();
  saveCalls = 0;

  async listAuditLogs(start: Date, end: Date) {
    return this.logs
      .filter((log) => log.createdAt >= start && log.createdAt < end)
      .sort(byTime);
  }

  async listPaymentAlerts(start: Date, end: Date) {
    return this.alerts
      .filter((alert) => alert.createdAt >= start && alert.createdAt < end)
      .sort(byTime);
  }

  async findAuditLog(id: string) {
    return this.logs.find((log) => log.id === id) ?? null;
  }

  async getAnchor(hourKey: string) {
    return this.anchors.get(hourKey) ?? null;
  }

  async saveAnchor(anchor: StoredAnchor) {
    this.saveCalls++;
    this.anchors.set(anchor.hourKey, anchor);
  }
}

function seededStore(): MemoryAnchorStore {
  const store = new MemoryAnchorStore();
  store.logs.push(
    { id: 'log-b', createdAt: new Date('2026-11-24T14:20:00Z'), canonicalPayload: 'audit-b' },
    { id: 'log-a', createdAt: new Date('2026-11-24T14:05:00Z'), canonicalPayload: 'audit-a' },
    // Outside the hour: must not be included in the root or proof.
    { id: 'log-old', createdAt: new Date('2026-11-24T13:59:00Z'), canonicalPayload: 'old' },
  );
  store.alerts.push(
    { id: 'alert-1', createdAt: new Date('2026-11-24T14:30:00Z'), canonicalPayload: 'alert-1' },
  );
  return store;
}

describe('hour helpers', () => {
  it('derives a UTC hour key and bounds', () => {
    expect(hourKeyFor(HOUR)).toBe('2026-11-24T14');
    expect(hourBounds(HOUR)).toEqual({
      start: new Date('2026-11-24T14:00:00Z'),
      end: new Date('2026-11-24T15:00:00Z'),
    });
  });
});

describe('OnChainNotaryService.anchorHour', () => {
  it('publishes a root over audit logs and payment alerts and persists the tx hash', async () => {
    const store = seededStore();
    const publisher: StellarPublisher = {
      publish: vi.fn(async () => ({ transactionHash: 'stellar-tx-1' })),
    };
    const service = new OnChainNotaryService(store, publisher);

    const result = await service.anchorHour(HOUR);

    const expectedRoot = buildMerkleTree(['audit-a', 'audit-b', 'alert-1']).root;
    expect(result).toMatchObject({
      hourKey: '2026-11-24T14',
      rootHash: expectedRoot,
      transactionHash: 'stellar-tx-1',
      leafCount: 3,
      alreadyAnchored: false,
    });
    expect(publisher.publish).toHaveBeenCalledWith(expectedRoot, '2026-11-24T14');
    expect(store.saveCalls).toBe(1);
    expect(store.anchors.get('2026-11-24T14')?.transactionHash).toBe('stellar-tx-1');
  });

  it('does not republish an already anchored hour unless forced', async () => {
    const store = seededStore();
    const publisher: StellarPublisher = {
      publish: vi.fn(async () => ({ transactionHash: 'stellar-tx-1' })),
    };
    const service = new OnChainNotaryService(store, publisher);

    const first = await service.anchorHour(HOUR);
    const second = await service.anchorHour(HOUR);
    const forced = await service.anchorHour(HOUR, { force: true });

    expect(first.alreadyAnchored).toBe(false);
    expect(second).toMatchObject({ ...first, alreadyAnchored: true });
    expect(forced.alreadyAnchored).toBe(false);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });
});

describe('OnChainNotaryService.getProof', () => {
  it('returns a verifiable proof with the Stellar anchor transaction hash', async () => {
    const store = seededStore();
    const publisher: StellarPublisher = {
      publish: vi.fn(async () => ({ transactionHash: 'stellar-tx-2' })),
    };
    const service = new OnChainNotaryService(store, publisher);
    await service.anchorHour(HOUR);

    const proof = await service.getProof('log-b');
    expect(proof).not.toBeNull();
    expect(proof?.leafIndex).toBe(1);
    expect(proof?.leafHash).toBe(buildMerkleTree(['audit-a', 'audit-b', 'alert-1']).leafHashes[1]);
    expect(proof?.path.length).toBeGreaterThan(0);
    expect(proof?.rootHash).toBe(buildMerkleTree(['audit-a', 'audit-b', 'alert-1']).root);
    expect(proof?.hourKey).toBe('2026-11-24T14');
    expect(proof?.stellarTransactionHash).toBe('stellar-tx-2');
    expect(proof?.anchored).toBe(true);
    expect(verifyInclusionProof(proof!)).toBe(true);
  });

  it('reports an unanchored hour without inventing a transaction hash', async () => {
    const service = new OnChainNotaryService(seededStore(), {
      publish: vi.fn(async () => ({ transactionHash: 'unused' })),
    });
    const proof = await service.getProof('log-a');
    expect(proof?.anchored).toBe(false);
    expect(proof?.stellarTransactionHash).toBeNull();
    expect(verifyInclusionProof(proof!)).toBe(true);
  });

  it('returns null for an unknown audit log id', async () => {
    const service = new OnChainNotaryService(seededStore(), {
      publish: vi.fn(async () => ({ transactionHash: 'unused' })),
    });
    expect(await service.getProof('missing')).toBeNull();
  });
});

describe('StellarManageDataPublisher', () => {
  it('puts the raw Merkle root into a manage_data operation using the configured account', async () => {
    const keypair = StellarSdk.Keypair.random();
    const submitted: any[] = [];
    const horizon = {
      loadAccount: vi.fn(async (publicKey: string) => new StellarSdk.Account(publicKey, '1')),
      submitTransaction: vi.fn(async (tx: any) => {
        submitted.push(tx);
        return { hash: 'published-hash' };
      }),
    };
    const publisher = new StellarManageDataPublisher({
      secret: keypair.secret(),
      horizon: horizon as any,
      networkPassphrase: StellarSdk.Networks.TESTNET,
    });
    const root = 'ab'.repeat(32);

    const result = await publisher.publish(root, '2026-11-24T14');

    expect(result).toEqual({ transactionHash: 'published-hash' });
    expect(horizon.loadAccount).toHaveBeenCalledWith(keypair.publicKey());
    expect(submitted).toHaveLength(1);
    const operation = submitted[0].operations[0];
    expect(operation.type).toBe('manageData');
    expect(operation.name).toBe('AUDIT_2026-11-24T14');
    expect(Buffer.from(operation.value).toString('hex')).toBe(root);
    expect(ANCHOR_EVENT_TYPE).toBe('AUDIT_ROOT_ANCHOR');
  });

  it('refuses malformed roots and missing signing keys', async () => {
    const publisher = new StellarManageDataPublisher({ secret: undefined });
    delete process.env.AUDIT_ANCHOR_STELLAR_SECRET;
    await expect(publisher.publish('nope', '2026-11-24T14')).rejects.toThrow(/malformed/);
    await expect(publisher.publish('ab'.repeat(32), '2026-11-24T14')).rejects.toThrow(/not configured/);
  });
});
