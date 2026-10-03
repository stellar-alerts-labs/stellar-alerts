import * as StellarSdk from 'stellar-sdk';
import { prisma } from '../lib/prisma';
import {
  stellar,
  countMultisigSignatures,
  MultisigSigner,
  MultisigThresholds,
  MultisigThresholdLevel,
} from '../lib/stellar';
import { registerSupervisorHeartbeat } from './supervisor';

const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;

// How often the watcher re-checks tracked treasuries' pending transactions.
const POLL_INTERVAL_MS = 30000;

export interface SignerApprovalNeeded {
  treasuryId: string;
  treasuryPublicKey: string;
  treasuryLabel: string | null;
  pendingTransactionId: string;
  innerTxHash: string;
  signerPublicKey: string;
  userId: string;
  collectedWeight: number;
  requiredThreshold: number;
  totalSigners: number;
}

export type SignerAuditIssueType =
  | 'signer_weight_changed'
  | 'master_key_weight_modified'
  | 'total_weight_below_threshold';

export interface SignerAuditFinding {
  issueType: SignerAuditIssueType;
  treasuryId: string;
  treasuryPublicKey: string;
  treasuryLabel: string | null;
  userId: string;
  signerPublicKey?: string;
  requiredThreshold: number;
  currentWeight?: number;
  totalWeight?: number;
  details: string;
}

export type MultisigAlertPayload = SignerApprovalNeeded | SignerAuditFinding;

/** Pluggable so tests (and future channel wiring) don't have to touch real notification infra. */
export type MultisigNotifier = (payload: MultisigAlertPayload) => Promise<void> | void;

export const defaultMultisigNotifier: MultisigNotifier = (payload) => {
  if ('issueType' in payload) {
    const prefix = payload.signerPublicKey ? payload.signerPublicKey.slice(0, 8) : 'treasury';
    console.log(
      `[MultisigWatcher] 🚨 ${payload.issueType} on treasury "${payload.treasuryLabel ?? payload.treasuryPublicKey.slice(0, 8)}" ` +
        `(${prefix}...) ${payload.details}`,
    );
    return;
  }

  console.log(
    `[MultisigWatcher] 🔔 Signature needed from ${payload.signerPublicKey.slice(0, 8)}... on treasury ` +
      `"${payload.treasuryLabel ?? payload.treasuryPublicKey.slice(0, 8)}" ` +
      `for tx ${payload.innerTxHash.slice(0, 12)}... ` +
      `(${payload.collectedWeight}/${payload.requiredThreshold} signing weight collected)`,
  );
};

interface TreasuryWithWatchers {
  id: string;
  publicKey: string;
  label: string | null;
  thresholdLevel: string;
  signerWatchers: { userId: string; signerPublicKey: string }[];
}

export interface SetOptionsAuditEvent {
  type?: string;
  signer_key?: string;
  signer_weight?: number | string;
  master_weight?: number | string;
}

export interface SignerAuditConfig {
  signers: MultisigSigner[];
  thresholds: MultisigThresholds;
  masterWeight: number;
}

interface PendingTxRecord {
  id: string;
  innerTxHash: string;
  envelopeXdr: string;
}

export function auditSignerConfiguration(
  config: SignerAuditConfig,
  thresholdLevel: MultisigThresholdLevel = 'medium',
  setOptionsEvent?: SetOptionsAuditEvent,
): SignerAuditFinding[] {
  const requiredThreshold =
    thresholdLevel === 'low'
      ? config.thresholds.low
      : thresholdLevel === 'high'
        ? config.thresholds.high
        : config.thresholds.medium;

  const findings: SignerAuditFinding[] = [];
  const totalWeight = config.signers.reduce((total, signer) => total + signer.weight, 0) + config.masterWeight;

  if (totalWeight < requiredThreshold) {
    findings.push({
      issueType: 'total_weight_below_threshold',
      treasuryId: '',
      treasuryPublicKey: '',
      treasuryLabel: null,
      userId: '',
      requiredThreshold,
      totalWeight,
      details: `Configured total signing weight ${totalWeight} is below the ${thresholdLevel} threshold (${requiredThreshold})`,
    });
  }

  if (setOptionsEvent?.type === 'set_options') {
    const eventSignerKey = setOptionsEvent.signer_key;
    if (eventSignerKey) {
      const signer = config.signers.find((candidate) => candidate.key === eventSignerKey);
      const eventSignerWeight =
        typeof setOptionsEvent.signer_weight === 'number'
          ? setOptionsEvent.signer_weight
          : Number.isFinite(Number(setOptionsEvent.signer_weight))
            ? Number(setOptionsEvent.signer_weight)
            : null;

      if (signer && eventSignerWeight !== null && signer.weight !== eventSignerWeight) {
        findings.push({
          issueType: 'signer_weight_changed',
          treasuryId: '',
          treasuryPublicKey: '',
          treasuryLabel: null,
          userId: '',
          signerPublicKey: eventSignerKey,
          requiredThreshold,
          currentWeight: eventSignerWeight,
          details: `Signer ${eventSignerKey.slice(0, 8)}... changed weight from ${signer.weight} to ${eventSignerWeight}`,
        });
      }
    }

    const eventMasterWeight =
      typeof setOptionsEvent.master_weight === 'number'
        ? setOptionsEvent.master_weight
        : Number.isFinite(Number(setOptionsEvent.master_weight))
          ? Number(setOptionsEvent.master_weight)
          : null;

    if (eventMasterWeight !== null && config.masterWeight !== eventMasterWeight) {
      findings.push({
        issueType: 'master_key_weight_modified',
        treasuryId: '',
        treasuryPublicKey: '',
        treasuryLabel: null,
        userId: '',
        requiredThreshold,
        currentWeight: eventMasterWeight,
        details: `Master key weight changed from ${config.masterWeight} to ${eventMasterWeight}`,
      });
    }
  }

  return findings;
}

/**
 * Re-counts a pending transaction's collected signatures against a
 * treasury's current on-chain signer set, persists the updated progress,
 * and notifies any remaining signer this pass hasn't already notified.
 *
 * Exported (and free of any polling/timer concerns) so it can be unit
 * tested directly against fixture data.
 */
export async function processPendingTransaction(
  treasury: TreasuryWithWatchers,
  pendingTx: PendingTxRecord,
  signers: MultisigSigner[],
  thresholds: MultisigThresholds,
  notify: MultisigNotifier = defaultMultisigNotifier,
) {
  const progress = countMultisigSignatures(
    pendingTx.envelopeXdr,
    signers,
    thresholds,
    NETWORK_PASSPHRASE,
    treasury.thresholdLevel as MultisigThresholdLevel,
  );

  const existing = await prisma.pendingMultisigTransaction.findUnique({
    where: { id: pendingTx.id },
    select: { notifiedJson: true, status: true },
  });
  const previouslyNotified: string[] = Array.isArray(existing?.notifiedJson)
    ? (existing!.notifiedJson as string[])
    : [];

  const newStatus = progress.thresholdMet ? 'threshold_met' : 'pending';

  await prisma.pendingMultisigTransaction.update({
    where: { id: pendingTx.id },
    data: {
      collectedWeight: progress.collectedWeight,
      signedByJson: progress.signedBy,
      status: newStatus,
    },
  });

  if (progress.thresholdMet) {
    return progress;
  }

  const remainingKeys = new Set(progress.remainingSigners.map((s) => s.key));
  const toNotify = treasury.signerWatchers.filter(
    (w) => remainingKeys.has(w.signerPublicKey) && !previouslyNotified.includes(w.signerPublicKey),
  );

  for (const watcher of toNotify) {
    await notify({
      treasuryId: treasury.id,
      treasuryPublicKey: treasury.publicKey,
      treasuryLabel: treasury.label,
      pendingTransactionId: pendingTx.id,
      innerTxHash: pendingTx.innerTxHash,
      signerPublicKey: watcher.signerPublicKey,
      userId: watcher.userId,
      collectedWeight: progress.collectedWeight,
      requiredThreshold: progress.requiredThreshold,
      totalSigners: progress.totalSigners,
    });
  }

  if (toNotify.length > 0) {
    const notifiedNow = Array.from(
      new Set([...previouslyNotified, ...toNotify.map((w) => w.signerPublicKey)]),
    );
    await prisma.pendingMultisigTransaction.update({
      where: { id: pendingTx.id },
      data: { notifiedJson: notifiedNow },
    });
  }

  return progress;
}

/** One poll pass over every watched treasury with pending transactions. */
export async function runMultisigWatcherPass(notify: MultisigNotifier = defaultMultisigNotifier) {
  const treasuries = await prisma.multisigTreasury.findMany({
    include: {
      signerWatchers: true,
      pendingTxs: { where: { status: 'pending' } },
    },
  });

  for (const treasury of treasuries) {
    const account = await stellar.getAccountSigners(treasury.publicKey);
    if (!account) {
      console.warn(
        `[MultisigWatcher] Could not load signers for treasury ${treasury.publicKey.slice(0, 8)}..., skipping this pass`,
      );
      continue;
    }

    const auditConfig = {
      signers: account.signers,
      thresholds: account.thresholds,
      masterWeight: account.masterWeight,
    };

    const latestSetOptions = (await stellar.getRecentSetOptionsOperations?.(treasury.publicKey, { limit: 5 }))?.[0];
    const findings = [...new Map(
      [...auditSignerConfiguration(auditConfig, treasury.thresholdLevel as MultisigThresholdLevel),
        ...auditSignerConfiguration(
          auditConfig,
          treasury.thresholdLevel as MultisigThresholdLevel,
          latestSetOptions,
        )].map((finding) => [
          `${finding.issueType}:${finding.signerPublicKey ?? 'master'}:${finding.details}`,
          finding,
        ]),
    ).values()];

    for (const finding of findings) {
      const targetWatchers = finding.signerPublicKey
        ? treasury.signerWatchers.filter((watcher) => watcher.signerPublicKey === finding.signerPublicKey)
        : treasury.signerWatchers;

      for (const watcher of targetWatchers) {
        await notify({
          ...finding,
          treasuryId: treasury.id,
          treasuryPublicKey: treasury.publicKey,
          treasuryLabel: treasury.label,
          userId: watcher.userId,
        });
      }
    }

    if (treasury.pendingTxs.length === 0) continue;

    for (const pendingTx of treasury.pendingTxs) {
      try {
        await processPendingTransaction(treasury, pendingTx, account.signers, account.thresholds, notify);
      } catch (err: any) {
        console.error(
          `[MultisigWatcher] Failed to process pending transaction ${pendingTx.id}:`,
          err?.message || err,
        );
      }
    }
  }
}

/**
 * Registers (or updates) a treasury transaction envelope for tracking.
 * Computes the inner transaction hash so re-submitting the same envelope
 * with additional signatures added updates the existing record instead of
 * creating a duplicate.
 */
export async function trackPendingTransaction(
  treasuryPublicKey: string,
  envelopeXdr: string,
  networkPassphrase: string = NETWORK_PASSPHRASE,
) {
  const treasury = await prisma.multisigTreasury.findUnique({ where: { publicKey: treasuryPublicKey } });
  if (!treasury) {
    throw new Error(`Unknown multisig treasury: ${treasuryPublicKey}`);
  }

  const account = await stellar.getAccountSigners(treasuryPublicKey);
  if (!account) {
    throw new Error(`Could not load signers for treasury ${treasuryPublicKey}`);
  }

  const parsed = StellarSdk.TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  const innerTx = 'innerTransaction' in parsed ? parsed.innerTransaction : parsed;
  const innerTxHash = innerTx.hash().toString('hex');

  const progress = countMultisigSignatures(
    envelopeXdr,
    account.signers,
    account.thresholds,
    networkPassphrase,
    treasury.thresholdLevel as MultisigThresholdLevel,
  );

  return prisma.pendingMultisigTransaction.upsert({
    where: { innerTxHash },
    create: {
      treasuryId: treasury.id,
      innerTxHash,
      envelopeXdr,
      requiredThreshold: progress.requiredThreshold,
      collectedWeight: progress.collectedWeight,
      signedByJson: progress.signedBy,
      status: progress.thresholdMet ? 'threshold_met' : 'pending',
    },
    update: {
      envelopeXdr,
      requiredThreshold: progress.requiredThreshold,
      collectedWeight: progress.collectedWeight,
      signedByJson: progress.signedBy,
      status: progress.thresholdMet ? 'threshold_met' : 'pending',
    },
  });
}

export async function runMultisigWatcher() {
  console.log('[MultisigWatcher] 🚀 Starting DAO Treasury Multisig Watcher Worker...');

  const poll = async () => {
    try {
      await runMultisigWatcherPass();
    } catch (error: any) {
      console.error('[MultisigWatcher] Polling error:', error?.message || error);
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runMultisigWatcher();
}
