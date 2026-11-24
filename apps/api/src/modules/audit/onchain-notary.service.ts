/**
 * Hourly audit anchoring to Stellar.
 *
 * Every audit log and payment-alert record in an hour is committed to an
 * RFC 6962 Merkle root (see ./merkle-tree.ts). The root is published in a
 * Stellar `manage_data` operation whose value is the raw 32-byte root hash;
 * the resulting transaction hash is persisted alongside the hour/root so a
 * client can verify an inclusion proof against an on-chain commitment.
 *
 * The data source and publisher are injected: tests run entirely in memory
 * and never touch PostgreSQL or Horizon.
 */

import * as StellarSdk from 'stellar-sdk';
import { prisma } from '../../lib/prisma';
import { stellarNetwork } from '../../config/network';
import {
  buildMerkleTree,
  canonicalJson,
  generateInclusionProof,
  verifyInclusionProof,
  type InclusionProof,
} from './merkle-tree';

/** Markers stored in SecurityAuditLog so anchors are durable without a new table. */
export const ANCHOR_EVENT_TYPE = 'AUDIT_ROOT_ANCHOR';

export interface NotaryLogRecord {
  id: string;
  canonicalPayload: string;
  createdAt: Date;
}

export interface StoredAnchor {
  hourKey: string;
  rootHash: string;
  transactionHash: string;
  leafCount: number;
  createdAt: Date;
}

export interface AuditAnchorStore {
  listAuditLogs(hourStart: Date, hourEnd: Date): Promise<NotaryLogRecord[]>;
  listPaymentAlerts(hourStart: Date, hourEnd: Date): Promise<NotaryLogRecord[]>;
  findAuditLog(id: string): Promise<NotaryLogRecord | null>;
  getAnchor(hourKey: string): Promise<StoredAnchor | null>;
  saveAnchor(anchor: StoredAnchor): Promise<void>;
}

export interface StellarPublisher {
  publish(rootHash: string, hourKey: string): Promise<{ transactionHash: string }>;
}

export interface AuditProof extends InclusionProof {
  hourKey: string;
  stellarTransactionHash: string | null;
  anchored: boolean;
}

export interface AnchorResult extends StoredAnchor {
  alreadyAnchored: boolean;
}

export function hourKeyFor(date: Date): string {
  return new Date(date).toISOString().slice(0, 13);
}

export function hourBounds(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setUTCMinutes(0, 0, 0);
  return { start, end: new Date(start.getTime() + 60 * 60 * 1000) };
}

function canonicalAuditLog(row: {
  id: string;
  eventType: string;
  txHash: string | null;
  topic: string | null;
  sequence: string | null;
  contractId: string | null;
  severity: string;
  details: unknown;
  createdAt: Date;
}): string {
  return canonicalJson({
    kind: 'audit_log',
    id: row.id,
    eventType: row.eventType,
    txHash: row.txHash,
    topic: row.topic,
    sequence: row.sequence,
    contractId: row.contractId,
    severity: row.severity,
    details: row.details ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

function canonicalPaymentAlert(row: {
  id: string;
  paymentId: string;
  channel: string;
  destination: string;
  status: string;
  createdAt: Date;
}): string {
  return canonicalJson({
    kind: 'payment_alert',
    id: row.id,
    paymentId: row.paymentId,
    channel: row.channel,
    destination: row.destination,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

/** Prisma-backed store. Anchor rows reuse SecurityAuditLog (topic = hour key). */
export const prismaAuditAnchorStore: AuditAnchorStore = {
  async listAuditLogs(hourStart, hourEnd) {
    const rows = await prisma.securityAuditLog.findMany({
      where: {
        createdAt: { gte: hourStart, lt: hourEnd },
        eventType: { not: ANCHOR_EVENT_TYPE },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      canonicalPayload: canonicalAuditLog(row),
    }));
  },
  async listPaymentAlerts(hourStart, hourEnd) {
    const rows = await prisma.notificationDelivery.findMany({
      where: { createdAt: { gte: hourStart, lt: hourEnd } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      canonicalPayload: canonicalPaymentAlert(row),
    }));
  },
  async findAuditLog(id) {
    const row = await prisma.securityAuditLog.findUnique({ where: { id } });
    if (!row || row.eventType === ANCHOR_EVENT_TYPE) return null;
    return {
      id: row.id,
      createdAt: row.createdAt,
      canonicalPayload: canonicalAuditLog(row),
    };
  },
  async getAnchor(hourKey) {
    const row = await prisma.securityAuditLog.findFirst({
      where: { eventType: ANCHOR_EVENT_TYPE, topic: hourKey },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || !row.txHash) return null;
    const details = (row.details ?? {}) as Record<string, unknown>;
    return {
      hourKey,
      rootHash: typeof details.rootHash === 'string' ? details.rootHash : '',
      transactionHash: row.txHash,
      leafCount: typeof details.leafCount === 'number' ? details.leafCount : 0,
      createdAt: row.createdAt,
    };
  },
  async saveAnchor(anchor) {
    await prisma.securityAuditLog.create({
      data: {
        eventType: ANCHOR_EVENT_TYPE,
        severity: 'INFO',
        topic: anchor.hourKey,
        txHash: anchor.transactionHash,
        details: {
          rootHash: anchor.rootHash,
          leafCount: anchor.leafCount,
          publishedAt: anchor.createdAt.toISOString(),
        },
        createdAt: anchor.createdAt,
      },
    });
  },
};

export interface StellarPublisherOptions {
  secret?: string;
  horizonUrl?: string;
  networkPassphrase?: string;
  fee?: string;
  timeoutSeconds?: number;
  horizon?: Pick<StellarSdk.Horizon.Server, 'loadAccount' | 'submitTransaction'>;
}

/** Publishes the root as raw bytes in a Stellar manage_data operation. */
export class StellarManageDataPublisher implements StellarPublisher {
  constructor(private readonly options: StellarPublisherOptions = {}) {}

  async publish(rootHash: string, hourKey: string): Promise<{ transactionHash: string }> {
    if (!/^[0-9a-f]{64}$/i.test(rootHash)) {
      throw new Error('Refusing to anchor a malformed Merkle root');
    }

    const secret = this.options.secret ?? process.env.AUDIT_ANCHOR_STELLAR_SECRET;
    if (!secret) {
      throw new Error('AUDIT_ANCHOR_STELLAR_SECRET is not configured');
    }

    const keypair = StellarSdk.Keypair.fromSecret(secret);
    const horizon =
      this.options.horizon ??
      new StellarSdk.Horizon.Server(
        this.options.horizonUrl ?? stellarNetwork.horizonEndpoints[0],
      );
    const networkPassphrase = this.options.networkPassphrase ?? stellarNetwork.networkPassphrase;
    const account = await horizon.loadAccount(keypair.publicKey());

    // Manage data names are limited to 28 bytes; "AUDIT_" + "YYYY-MM-DDTHH" is 19.
    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee: this.options.fee ?? '100',
      networkPassphrase,
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          name: `AUDIT_${hourKey}`,
          value: Buffer.from(rootHash, 'hex'),
        }),
      )
      .setTimeout(this.options.timeoutSeconds ?? 30)
      .build();
    transaction.sign(keypair);

    const result = await horizon.submitTransaction(transaction);
    return { transactionHash: result.hash };
  }
}

export class OnChainNotaryService {
  constructor(
    private readonly store: AuditAnchorStore = prismaAuditAnchorStore,
    private readonly publisher: StellarPublisher = new StellarManageDataPublisher(),
  ) {}

  /** Deterministic leaf set: audit logs first, then payment alerts, each time-ordered. */
  private async collectLeaves(hourStart: Date, hourEnd: Date): Promise<NotaryLogRecord[]> {
    const [auditLogs, paymentAlerts] = await Promise.all([
      this.store.listAuditLogs(hourStart, hourEnd),
      this.store.listPaymentAlerts(hourStart, hourEnd),
    ]);
    return [...auditLogs, ...paymentAlerts];
  }

  /** Anchors the given UTC hour (defaults to the current hour). */
  async anchorHour(at: Date = new Date(), options: { force?: boolean } = {}): Promise<AnchorResult> {
    const hourKey = hourKeyFor(at);
    if (!options.force) {
      const existing = await this.store.getAnchor(hourKey);
      if (existing) return { ...existing, alreadyAnchored: true };
    }

    const { start, end } = hourBounds(at);
    const leaves = await this.collectLeaves(start, end);
    const tree = buildMerkleTree(leaves.map((leaf) => leaf.canonicalPayload));
    const { transactionHash } = await this.publisher.publish(tree.root, hourKey);

    const anchor: StoredAnchor = {
      hourKey,
      rootHash: tree.root,
      transactionHash,
      leafCount: leaves.length,
      createdAt: new Date(),
    };
    await this.store.saveAnchor(anchor);
    return { ...anchor, alreadyAnchored: false };
  }

  /** Verifiable inclusion proof for an audit log id, with its Stellar anchor. */
  async getProof(auditLogId: string): Promise<AuditProof | null> {
    const record = await this.store.findAuditLog(auditLogId);
    if (!record) return null;

    const hourKey = hourKeyFor(record.createdAt);
    const { start, end } = hourBounds(record.createdAt);
    const leaves = await this.collectLeaves(start, end);
    const leafIndex = leaves.findIndex((leaf) => leaf.id === auditLogId);
    if (leafIndex === -1) return null;

    const tree = buildMerkleTree(leaves.map((leaf) => leaf.canonicalPayload));
    const proof = generateInclusionProof(tree, leafIndex);
    if (!verifyInclusionProof(proof)) {
      throw new Error('Generated audit inclusion proof failed verification');
    }

    const anchor = await this.store.getAnchor(hourKey);
    return {
      ...proof,
      hourKey,
      stellarTransactionHash: anchor?.transactionHash ?? null,
      anchored: Boolean(anchor),
    };
  }
}

export const onChainNotaryService = new OnChainNotaryService();
