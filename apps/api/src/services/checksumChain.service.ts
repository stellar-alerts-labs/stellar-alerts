import * as crypto from 'crypto';
import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { buildMerkleTree, generateMerkleProof, hashMerkleLeaf, verifyMerkleProof } from '../utils/merkle-verifier';

const log = createLogger({ module: 'ChecksumChainService' });

/**
 * Fixed root-of-trust for the very first PaymentChecksum row ever appended
 * (there is no real "previous record" to point to yet). Namespaced so it
 * can never collide with a real sha256 output of chain data.
 */
export const GENESIS_HASH = sha256Hex('stellar-alerts:payment-checksum-chain:genesis');

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export interface ChainablePayment {
  id: string;
  txHash: string;
  walletId: string;
  fromAddress: string;
  amount: Prisma.Decimal | string | number;
  asset: string;
  assetIssuer: string | null;
  memo: string | null;
  receivedAt: Date;
}

/**
 * Canonical, order-stable serialization of a Payment's immutable fields,
 * hashed with SHA-256. Mirrors utils/receipt-generator.ts's
 * computeReceiptVerificationHash pipe-joined convention, for consistency
 * across the codebase's checksum-hashing utilities. Only fields that never
 * change after a Payment row is created are included, so payloadHash is
 * stable for the lifetime of the row.
 */
export function computePayloadHash(payment: ChainablePayment): string {
  const canonical = [
    payment.id,
    payment.walletId,
    payment.txHash,
    payment.fromAddress,
    String(payment.amount),
    payment.asset,
    payment.assetIssuer ?? 'N/A',
    payment.memo ?? 'N/A',
    new Date(payment.receivedAt).toISOString(),
  ].join('|');
  return sha256Hex(canonical);
}

/** The hash-pointer link: this row's commitment to "everything before it" plus its own payload. */
export function computeChainHash(previousHash: string, payloadHash: string): string {
  return sha256Hex(`${previousHash}:${payloadHash}`);
}

const MAX_APPEND_RETRIES = 5;

function isSerializationFailure(err: any): boolean {
  // P2034: Prisma's mapped code for a Postgres serialization failure /
  // deadlock detected under Serializable isolation (SQLSTATE 40001/40P01).
  return err?.code === 'P2034' || /could not serialize access|deadlock detected/i.test(String(err?.message ?? ''));
}

/**
 * Appends the next PaymentChecksum row for a newly-ingested Payment,
 * linking it to the current chain tail (or GENESIS_HASH for the very first
 * row). "Current tail" is read and written inside a single Serializable
 * transaction so that two callers racing to append (e.g. the SSE watcher
 * and a concurrent backfill pass ingesting different payments at the same
 * moment) can't both read the same tail and each compute a chainHash
 * pointing at it — Postgres aborts one side with a serialization failure
 * instead, which is retried with a small backoff. This keeps the chain a
 * single linear sequence rather than letting it silently fork.
 *
 * Deliberately never throws past this function: a checksum-chain bug must
 * never block real payment ingestion or alert delivery, which remains the
 * system's actual job. A failed append (retries exhausted) is logged and
 * returns null; {@link verifyChain} run out-of-band will surface the
 * resulting gap (a Payment with no PaymentChecksum row) so it can be
 * backfilled/investigated without having blocked ingestion in the moment.
 */
export async function appendPaymentChecksum(payment: ChainablePayment): Promise<{ chainHash: string } | null> {
  const payloadHash = computePayloadHash(payment);

  for (let attempt = 1; attempt <= MAX_APPEND_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const tail = await tx.paymentChecksum.findFirst({ orderBy: { sequence: 'desc' } });
          const previousHash = tail?.chainHash ?? GENESIS_HASH;
          const chainHash = computeChainHash(previousHash, payloadHash);

          const created = await tx.paymentChecksum.create({
            data: { paymentId: payment.id, payloadHash, previousHash, chainHash },
          });

          return { chainHash: created.chainHash };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // A checksum row for this payment already exists — most likely this
        // same ingestion path retrying after a transient failure. Treat as
        // already-done rather than an error.
        const existing = await prisma.paymentChecksum.findUnique({ where: { paymentId: payment.id } });
        if (existing) return { chainHash: existing.chainHash };
      }

      if (isSerializationFailure(err) && attempt < MAX_APPEND_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
        continue;
      }

      log.error({ err, paymentId: payment.id, attempt }, '❌ Failed to append payment checksum chain entry');
      return null;
    }
  }

  return null;
}

export interface ChainVerificationResult {
  valid: boolean;
  checkedCount: number;
  /** Sequence number of the first row whose chainHash doesn't recompute, if any. */
  brokenAtSequence: number | null;
  reason: string | null;
}

/**
 * Walks the entire PaymentChecksum chain from genesis, recomputing each
 * row's chainHash from its own payloadHash and the previous row's stored
 * chainHash, and confirms it matches what's stored. This is what would
 * actually catch tampering: modifying or deleting any historical row (or
 * the Payment row a payloadHash was computed from) breaks the recomputed
 * chainHash for that row and, transitively, every row after it.
 */
export async function verifyChain(): Promise<ChainVerificationResult> {
  const rows = await prisma.paymentChecksum.findMany({ orderBy: { sequence: 'asc' } });

  let previousHash = GENESIS_HASH;
  let checkedCount = 0;

  for (const row of rows) {
    if (row.previousHash !== previousHash) {
      return {
        valid: false,
        checkedCount,
        brokenAtSequence: row.sequence,
        reason: `Row ${row.id} (sequence ${row.sequence}) records previousHash "${row.previousHash}" but the chain's actual previous chainHash is "${previousHash}"`,
      };
    }

    const expectedChainHash = computeChainHash(row.previousHash, row.payloadHash);
    if (expectedChainHash !== row.chainHash) {
      return {
        valid: false,
        checkedCount,
        brokenAtSequence: row.sequence,
        reason: `Row ${row.id} (sequence ${row.sequence}) chainHash does not match recomputed value — its payloadHash, previousHash, or stored chainHash has been altered`,
      };
    }

    previousHash = row.chainHash;
    checkedCount++;
  }

  return { valid: true, checkedCount, brokenAtSequence: null, reason: null };
}

function utcDayString(date: Date): string {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export interface DailyMerkleRootResult {
  date: string;
  merkleRoot: string;
  leafCount: number;
}

/**
 * Computes (and upserts) the Merkle root over every PaymentChecksum's
 * payloadHash appended on the given UTC calendar day, using this
 * codebase's existing domain-separated Merkle primitives
 * (utils/merkle-verifier.ts) rather than ad-hoc hashing. payloadHash (not
 * chainHash) is used as the leaf so the daily root commits to "this exact
 * set of payments was ingested that day", independent of chain-linkage
 * bookkeeping. Returns null if there were no checksums for that day (a
 * Merkle tree can't be built from zero leaves).
 */
export async function computeDailyMerkleRoot(day: Date = new Date()): Promise<DailyMerkleRootResult | null> {
  const dateStr = utcDayString(day);
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const dayEnd = new Date(`${dateStr}T23:59:59.999Z`);

  const rows = await prisma.paymentChecksum.findMany({
    where: { createdAt: { gte: dayStart, lte: dayEnd } },
    orderBy: { sequence: 'asc' },
  });

  if (rows.length === 0) {
    log.info({ date: dateStr }, 'ℹ️ No payment checksums to roll up into a daily Merkle root');
    return null;
  }

  const leaves = rows.map((row) => Buffer.from(row.payloadHash, 'hex'));
  const tree = buildMerkleTree(leaves);

  await prisma.dailyChecksumRoot.upsert({
    where: { date: dateStr },
    create: { date: dateStr, merkleRoot: tree.root, leafCount: rows.length },
    update: { merkleRoot: tree.root, leafCount: rows.length, computedAt: new Date() },
  });

  log.info({ date: dateStr, leafCount: rows.length, merkleRoot: tree.root }, '✅ Computed daily payment checksum Merkle root');

  return { date: dateStr, merkleRoot: tree.root, leafCount: rows.length };
}

/**
 * Verifies a single payment's checksum is included in a given day's stored
 * Merkle root, by rebuilding that day's tree and checking a fresh
 * inclusion proof — exercising the same generateMerkleProof/
 * verifyMerkleProof path a lightweight external verifier would use, rather
 * than just comparing hashes directly.
 */
export async function verifyPaymentInDailyRoot(paymentId: string, day: Date): Promise<boolean> {
  const dateStr = utcDayString(day);
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const dayEnd = new Date(`${dateStr}T23:59:59.999Z`);

  const [target, storedRoot] = await Promise.all([
    prisma.paymentChecksum.findUnique({ where: { paymentId } }),
    prisma.dailyChecksumRoot.findUnique({ where: { date: dateStr } }),
  ]);

  if (!target || !storedRoot) return false;

  const rows = await prisma.paymentChecksum.findMany({
    where: { createdAt: { gte: dayStart, lte: dayEnd } },
    orderBy: { sequence: 'asc' },
  });

  const leafIndex = rows.findIndex((row) => row.id === target.id);
  if (leafIndex === -1) return false;

  const leaves = rows.map((row) => Buffer.from(row.payloadHash, 'hex'));
  const tree = buildMerkleTree(leaves);
  const proofPath = generateMerkleProof(tree, leafIndex);

  return verifyMerkleProof({ leafHash: hashMerkleLeaf(leaves[leafIndex]), path: proofPath }, storedRoot.merkleRoot);
}
