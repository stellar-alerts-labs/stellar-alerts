import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as StellarSdk from 'stellar-sdk';
import {
  hashMerkleLeaf,
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  MerkleProofStep,
} from '@stellar-alerts/shared';
import { apiClient } from '../lib/api.js';
import { PaymentDTO } from '../lib/types.js';

/**
 * IMPORTANT — SCOPE OF THIS COMMAND (read before trusting the output):
 *
 * This command does NOT reconstruct Stellar Core's consensus-level ledger
 * transaction-set Merkle hash tree (the `txSetResultHash` inside a ledger
 * header) and it does NOT produce a proof that a transaction was included in
 * a specific ledger the way a full validator or a captive-core light client
 * would. Horizon's public API does not expose Core's XDR `GeneralizedTransactionSet`
 * or per-transaction inclusion proofs against it, so a genuine protocol-level
 * Merkle inclusion proof isn't something this CLI (or Horizon) can produce
 * today without replaying Core's exact hashing algorithm — attempting that
 * with Horizon-only data would be easy to get subtly wrong or misleading.
 *
 * What this command actually does, and why it's still useful:
 *   1. Takes each locally cached payment record (what this app's own database
 *      believes happened, via `apiClient.getPayments`) and independently
 *      re-queries Horizon directly for that transaction, comparing the
 *      cached amount/asset/sender against what Horizon reports. This catches
 *      local DB corruption or tampering: a cached amount, asset, or sender
 *      that doesn't match the real on-chain record.
 *   2. Builds a Merkle tree (using this monorepo's shared, tested,
 *      domain-separated SHA-256 primitives) over the hashes of every
 *      successfully cross-checked record, and emits a "verification
 *      certificate" containing the Merkle root plus each record's own leaf
 *      hash and inclusion proof path.
 *
 * The certificate is a tamper-evident commitment over "the set of locally
 * cached records that were independently confirmed to match Horizon at
 * generation time" — not a consensus-level ledger inclusion proof. Given the
 * certificate's root, `verify-ledger check <file>` can later confirm a
 * single record's proof (and that the record hasn't been edited since) without
 * re-fetching anything from Horizon or the API.
 */

const SCOPE_NOTE =
  'This certificate verifies each cached payment record against what Horizon independently reports for its transaction hash (catches local DB corruption/tampering), and commits to the verified set with a Merkle tree built from this repo\'s shared SHA-256 primitives. It is NOT a consensus-level Stellar Core ledger transaction-set Merkle inclusion proof — Horizon\'s public API does not expose the data needed to build one honestly.';

const CERTIFICATE_VERSION = 1;

type RecordStatus = 'verified' | 'mismatch' | 'unverifiable';

interface HorizonComparison {
  amount: string;
  asset: string;
  fromAddress: string;
}

interface CertificateRecord {
  paymentId: string;
  walletId: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  asset: string;
  receivedAt: string;
  status: RecordStatus;
  reason?: string;
  horizonRecord?: HorizonComparison;
  leafHash?: string;
  leafIndex?: number;
  merkleProof?: MerkleProofStep[];
}

export interface VerificationCertificate {
  certificateVersion: number;
  generatedAt: string;
  horizonUrl: string;
  scopeNote: string;
  summary: {
    total: number;
    verified: number;
    mismatched: number;
    unverifiable: number;
  };
  merkleRoot: string | null;
  records: CertificateRecord[];
}

/** Builds the canonical string hashed into a record's Merkle leaf — mirrors the
 * canonical-string-then-hash pattern used by `computeReceiptVerificationHash`
 * in apps/api/src/utils/receipt-generator.ts. */
export function canonicalRecordString(record: {
  paymentId: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  asset: string;
  receivedAt: string;
}): string {
  return [
    record.paymentId,
    record.txHash,
    record.fromAddress,
    record.amount,
    record.asset,
    record.receivedAt,
  ].join('|');
}

function normalizeAsset(assetType: string, assetCode?: string): string {
  if (assetType === 'native') return 'XLM';
  return (assetCode || 'Unknown').toUpperCase();
}

function amountsMatch(a: string | number, b: string): boolean {
  const numA = typeof a === 'number' ? a : parseFloat(a);
  const numB = parseFloat(b);
  if (Number.isNaN(numA) || Number.isNaN(numB)) return false;
  // Stellar amounts carry up to 7 decimal places of precision.
  return Math.abs(numA - numB) < 1e-6;
}

/**
 * Independently re-verifies a single cached payment record against Horizon.
 * Never throws — a Horizon network error, a not-found transaction, or a
 * value mismatch are all returned as a status rather than crashing the
 * whole audit run.
 */
export async function verifyPaymentAgainstHorizon(
  server: InstanceType<typeof StellarSdk.Horizon.Server>,
  payment: PaymentDTO
): Promise<{ status: RecordStatus; reason?: string; horizonRecord?: HorizonComparison }> {
  let operationRecords: Array<{ type: string; from?: string; amount?: string; asset_type?: string; asset_code?: string }>;

  try {
    const page = await server.payments().forTransaction(payment.txHash).call();
    operationRecords = page.records as any[];
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 404) {
      return { status: 'unverifiable', reason: `Transaction ${payment.txHash} not found on Horizon` };
    }
    return {
      status: 'unverifiable',
      reason: `Horizon lookup failed: ${error?.message || String(error)}`,
    };
  }

  const paymentLikeOps = operationRecords.filter(
    (op) =>
      op.type === 'payment' ||
      op.type === 'path_payment_strict_receive' ||
      op.type === 'path_payment_strict_send'
  );

  if (paymentLikeOps.length === 0) {
    return {
      status: 'unverifiable',
      reason: `No payment operations found on Horizon for transaction ${payment.txHash}`,
    };
  }

  for (const op of paymentLikeOps) {
    const horizonRecord: HorizonComparison = {
      amount: op.amount || '0',
      asset: normalizeAsset(op.asset_type || 'native', op.asset_code),
      fromAddress: op.from || '',
    };

    const assetMatches = horizonRecord.asset === (payment.asset || '').toUpperCase();
    const fromMatches = horizonRecord.fromAddress === payment.fromAddress;
    const amountMatches = amountsMatch(payment.amount, horizonRecord.amount);

    if (assetMatches && fromMatches && amountMatches) {
      return { status: 'verified' };
    }
  }

  // Horizon has payment operations for this tx, but none match the cached
  // record's fields — report the first candidate for a human-readable diff.
  const first = paymentLikeOps[0];
  return {
    status: 'mismatch',
    reason: 'Cached record does not match any payment operation Horizon reports for this transaction',
    horizonRecord: {
      amount: first.amount || '0',
      asset: normalizeAsset(first.asset_type || 'native', first.asset_code),
      fromAddress: first.from || '',
    },
  };
}

export async function runAudit(options: {
  wallet?: string;
  limit?: string;
  token?: string;
  output?: string;
  horizonUrl: string;
}): Promise<VerificationCertificate | null> {
  if (options.token) {
    apiClient['apiKey'] = options.token;
  }

  const limit = options.limit ? parseInt(options.limit, 10) : 50;
  console.log(chalk.blue('🔄 Fetching locally cached payment history...'));
  const payments = await apiClient.getPayments(options.wallet, limit);

  if (payments.length === 0) {
    console.log(chalk.yellow('📭 No cached payments found — nothing to verify.'));
    return null;
  }

  console.log(chalk.gray(`Independently re-checking ${payments.length} record(s) against Horizon (${options.horizonUrl})...`));

  const server = new StellarSdk.Horizon.Server(options.horizonUrl);

  const verifiedLeaves: { record: CertificateRecord; leafData: Buffer }[] = [];
  const records: CertificateRecord[] = [];

  for (const payment of payments) {
    const receivedAtIso = new Date(payment.receivedAt).toISOString();
    const base: Omit<CertificateRecord, 'status'> = {
      paymentId: payment.id,
      walletId: payment.walletId,
      txHash: payment.txHash,
      fromAddress: payment.fromAddress,
      amount: String(payment.amount),
      asset: payment.asset,
      receivedAt: receivedAtIso,
    };

    const result = await verifyPaymentAgainstHorizon(server, payment);

    if (result.status === 'verified') {
      const leafData = Buffer.from(canonicalRecordString(base), 'utf8');
      const record: CertificateRecord = { ...base, status: 'verified' };
      verifiedLeaves.push({ record, leafData });
      records.push(record);
      console.log(`  ${chalk.green('✅')} ${chalk.gray(payment.txHash.slice(0, 12) + '...')} verified against Horizon`);
    } else if (result.status === 'mismatch') {
      const record: CertificateRecord = {
        ...base,
        status: 'mismatch',
        reason: result.reason,
        horizonRecord: result.horizonRecord,
      };
      records.push(record);
      console.log(`  ${chalk.red('❌')} ${chalk.gray(payment.txHash.slice(0, 12) + '...')} MISMATCH: ${result.reason}`);
    } else {
      const record: CertificateRecord = { ...base, status: 'unverifiable', reason: result.reason };
      records.push(record);
      console.log(`  ${chalk.yellow('⚠️')}  ${chalk.gray(payment.txHash.slice(0, 12) + '...')} could not verify: ${result.reason}`);
    }
  }

  let merkleRoot: string | null = null;
  if (verifiedLeaves.length > 0) {
    const tree = buildMerkleTree(verifiedLeaves.map((v) => v.leafData));
    merkleRoot = tree.root;

    verifiedLeaves.forEach((v, index) => {
      const leafHash = hashMerkleLeaf(v.leafData);
      v.record.leafHash = leafHash;
      v.record.leafIndex = index;
      v.record.merkleProof = generateMerkleProof(tree, index);
    });
  }

  const summary = {
    total: records.length,
    verified: records.filter((r) => r.status === 'verified').length,
    mismatched: records.filter((r) => r.status === 'mismatch').length,
    unverifiable: records.filter((r) => r.status === 'unverifiable').length,
  };

  const certificate: VerificationCertificate = {
    certificateVersion: CERTIFICATE_VERSION,
    generatedAt: new Date().toISOString(),
    horizonUrl: options.horizonUrl,
    scopeNote: SCOPE_NOTE,
    summary,
    merkleRoot,
    records,
  };

  console.log('');
  console.log(chalk.bold.blue('📜 Verification Certificate Summary'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(`  Total records:   ${summary.total}`);
  console.log(`  ${chalk.green('Verified:')}        ${summary.verified}`);
  console.log(`  ${chalk.red('Mismatched:')}      ${summary.mismatched}`);
  console.log(`  ${chalk.yellow('Unverifiable:')}    ${summary.unverifiable}`);
  console.log(`  Merkle root:     ${merkleRoot ? chalk.cyan(merkleRoot) : chalk.gray('(none — no verified records)')}`);
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.gray(`  Scope: cached-record integrity vs. Horizon + tamper-evident Merkle`));
  console.log(chalk.gray(`  commitment over the verified set. NOT a consensus-level ledger proof.`));

  if (summary.mismatched > 0) {
    console.log(chalk.red(`\n❌ ${summary.mismatched} record(s) do not match Horizon — possible local data corruption or tampering.`));
  }

  if (options.output) {
    fs.writeFileSync(options.output, JSON.stringify(certificate, null, 2), 'utf8');
    console.log(chalk.green(`\n✅ Certificate written to ${options.output}`));
  }

  return certificate;
}

export interface CertificateCheckResult {
  /** True only if every verified record's leaf hash and Merkle proof check out. */
  passed: boolean;
  checked: number;
  failures: number;
  /** Human-readable reason per record id that failed (tamper detection detail). */
  failureReasons: Record<string, string>;
}

/**
 * Recomputes and validates every "verified" record in a certificate against
 * its stored Merkle root — the "Merkle proof checker" half of this command.
 * Detects two distinct kinds of tampering: (1) a record's own fields were
 * edited after the certificate was generated (its recomputed leaf hash no
 * longer matches the stored leafHash), and (2) the leaf hash, proof path, or
 * root were edited directly (the Merkle proof no longer validates). Never
 * throws for a malformed certificate — returns a failed result instead.
 */
export function checkCertificateRecords(certificate: VerificationCertificate): CertificateCheckResult {
  const verifiedRecords = (certificate.records || []).filter((r) => r.status === 'verified');
  const failureReasons: Record<string, string> = {};

  if (!certificate.merkleRoot || verifiedRecords.length === 0) {
    return { passed: true, checked: 0, failures: 0, failureReasons };
  }

  for (const record of verifiedRecords) {
    if (!record.leafHash || !record.merkleProof) {
      failureReasons[record.paymentId] = 'missing leafHash/merkleProof in certificate';
      continue;
    }

    // Re-derive the leaf hash from the record's own recorded fields. If the
    // certificate JSON was edited after generation (e.g. an amount changed
    // but leafHash left alone), this will no longer match the stored leaf
    // hash even before we touch the Merkle proof.
    const recomputedLeafHash = hashMerkleLeaf(
      Buffer.from(
        canonicalRecordString({
          paymentId: record.paymentId,
          txHash: record.txHash,
          fromAddress: record.fromAddress,
          amount: record.amount,
          asset: record.asset,
          receivedAt: record.receivedAt,
        }),
        'utf8'
      )
    );

    if (recomputedLeafHash !== record.leafHash) {
      failureReasons[record.paymentId] = 'record data does not match its recorded leaf hash (tampered?)';
      continue;
    }

    const proofValid = verifyMerkleProof(
      { leafHash: record.leafHash, path: record.merkleProof },
      certificate.merkleRoot
    );

    if (!proofValid) {
      failureReasons[record.paymentId] = 'Merkle proof does NOT validate against the stored root';
    }
  }

  const failures = Object.keys(failureReasons).length;
  return { passed: failures === 0, checked: verifiedRecords.length, failures, failureReasons };
}

export function checkCertificate(filePath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(chalk.red(`❌ Could not read certificate file: ${(error as Error).message}`));
    process.exit(1);
    return;
  }

  let certificate: VerificationCertificate;
  try {
    certificate = JSON.parse(raw);
  } catch (error) {
    console.error(chalk.red(`❌ Certificate file is not valid JSON: ${(error as Error).message}`));
    process.exit(1);
    return;
  }

  const verifiedCount = (certificate.records || []).filter((r) => r.status === 'verified').length;

  if (!certificate.merkleRoot || verifiedCount === 0) {
    console.log(chalk.yellow('⚠️  Certificate has no Merkle root or no verified records to check.'));
    return;
  }

  console.log(chalk.blue(`🔍 Checking ${verifiedCount} verified record(s) against root ${certificate.merkleRoot}...\n`));

  const result = checkCertificateRecords(certificate);

  for (const record of (certificate.records || []).filter((r) => r.status === 'verified')) {
    const failureReason = result.failureReasons[record.paymentId];
    if (failureReason) {
      console.log(`  ${chalk.red('❌')} ${record.paymentId}: ${failureReason}`);
    } else {
      console.log(`  ${chalk.green('✅')} ${record.paymentId}: proof valid`);
    }
  }

  console.log('');
  if (!result.passed) {
    console.log(chalk.red(`❌ Certificate check FAILED: ${result.failures} of ${result.checked} record(s) invalid.`));
    process.exit(1);
  } else {
    console.log(chalk.green(`✅ Certificate check passed: all ${result.checked} verified record(s) are intact.`));
  }
}

export function registerVerifyLedgerCommands(program: Command): void {
  const verifyLedger = program
    .command('verify-ledger')
    .description(
      'Audit locally cached payment records against Horizon and emit a Merkle verification certificate. ' +
        'SCOPE: this independently re-checks each cached record (amount/asset/sender) against what Horizon ' +
        'reports for its transaction hash, and builds a tamper-evident Merkle commitment over the records that ' +
        'matched. It does NOT reconstruct Stellar Core\'s consensus-level ledger transaction-set Merkle tree — ' +
        'Horizon\'s public API does not expose the data needed to do that. Use "verify-ledger check <file>" to ' +
        'later validate a previously generated certificate\'s Merkle proofs without re-fetching anything.'
    )
    .option('-w, --wallet <walletId>', 'Only audit payments for this wallet ID')
    .option('-l, --limit <number>', 'Maximum number of cached payments to audit', '50')
    .option('-o, --output <path>', 'Write the full verification certificate JSON to this file')
    .option('-t, --token <token>', 'API authentication token')
    .option('--horizon-url <url>', 'Horizon server URL to independently verify against', process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org')
    .action(async (options: { wallet?: string; limit?: string; output?: string; token?: string; horizonUrl: string }) => {
      try {
        const certificate = await runAudit(options);
        if (certificate && certificate.summary.mismatched > 0) {
          process.exit(1);
        }
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });

  verifyLedger
    .command('check')
    .description(
      'Validate a previously generated verification certificate: recomputes each verified record\'s leaf hash ' +
        'from its stored fields and checks its Merkle proof against the certificate\'s recorded root, without ' +
        're-fetching anything from Horizon or the API.'
    )
    .argument('<certificateFile>', 'Path to a verification certificate JSON file produced by "verify-ledger"')
    .action((certificateFile: string) => {
      try {
        checkCertificate(certificateFile);
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}
