import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { stellar, MultisigThresholdLevel } from '../lib/stellar';
import {
  SignerInactivityWatcher,
  signerInactivityWatcher,
  buildSignerActivities,
  TreasuryInactivityAssessment,
} from '../services/signerInactivityWatcher';
import { registerSupervisorHeartbeat } from './supervisor';

// #1008: periodically re-assesses each tracked multi-sig treasury's quorum
// resilience against signer inactivity / key-weight decay and warns admins when
// abandonment threatens the ability to reach quorum.

const POLL_INTERVAL_MS = parseInt(env.MULTISIG_INACTIVITY_INTERVAL_MS || '3600000', 10);

let isProcessing = false;

/**
 * Resolves the last-signing timestamp per signer key for a treasury. Pluggable
 * so the signing-history source (audit log, ledger scan, …) can evolve without
 * touching the assessment logic, and so tests can inject fixtures.
 */
export type SignerActivityResolver = (
  treasury: { id: string; publicKey: string },
) => Promise<Map<string, Date>> | Map<string, Date>;

export type MultisigInactivityNotifier = (
  assessment: TreasuryInactivityAssessment,
) => Promise<void> | void;

export const defaultMultisigInactivityNotifier: MultisigInactivityNotifier = (assessment) => {
  const tag = assessment.risk === 'CRITICAL' ? '🚨' : '⚠️';
  console.log(
    `[MultisigInactivity] ${tag} ${assessment.publicKey.slice(0, 8)}... [${assessment.risk}] ` +
      `${assessment.message} (at-risk signers: ${assessment.atRiskSigners.length})`,
  );
};

interface TreasuryRecord {
  id: string;
  publicKey: string;
  label: string | null;
  thresholdLevel: string;
}

/**
 * Assesses a single treasury: loads its on-chain signers + thresholds, joins
 * them with observed signing activity, and returns the assessment (or null when
 * the account can't be loaded).
 */
export async function assessTreasuryRecord(
  treasury: TreasuryRecord,
  resolveActivity: SignerActivityResolver,
  watcher: SignerInactivityWatcher = signerInactivityWatcher,
  now: number = Date.now(),
): Promise<TreasuryInactivityAssessment | null> {
  const account = await stellar.getAccountSigners(treasury.publicKey);
  if (!account) return null;

  const lastActiveByKey = await resolveActivity({ id: treasury.id, publicKey: treasury.publicKey });
  const signers = buildSignerActivities(account.signers, lastActiveByKey);

  return watcher.assessTreasury(
    {
      treasuryId: treasury.id,
      publicKey: treasury.publicKey,
      label: treasury.label,
      thresholds: account.thresholds,
      thresholdLevel: (treasury.thresholdLevel as MultisigThresholdLevel) || 'medium',
      signers,
    },
    now,
  );
}

export async function runMultisigInactivityPass(
  resolveActivity: SignerActivityResolver,
  notify: MultisigInactivityNotifier = defaultMultisigInactivityNotifier,
): Promise<TreasuryInactivityAssessment[]> {
  const treasuries = await prisma.multisigTreasury.findMany({
    select: { id: true, publicKey: true, label: true, thresholdLevel: true },
  });

  if (treasuries.length === 0) {
    console.log('[MultisigInactivity] No tracked treasuries found. Pass complete.');
    return [];
  }

  const results: TreasuryInactivityAssessment[] = [];
  for (const treasury of treasuries) {
    try {
      const assessment = await assessTreasuryRecord(treasury, resolveActivity);
      if (assessment && assessment.risk !== 'OK') {
        results.push(assessment);
        await notify(assessment);
      }
    } catch (error: any) {
      console.error(
        `[MultisigInactivity] Error assessing treasury ${treasury.publicKey}:`,
        error?.message || error,
      );
    }
  }
  return results;
}

/**
 * Default activity resolver backed by PendingMultisigTransaction envelopes: a
 * signer that appears in a treasury's collected-signature history is credited
 * with the most recent such transaction's timestamp. Best-effort — treasuries
 * with no stored history simply have no observed activity.
 */
export async function resolveActivityFromPendingTxs(treasury: {
  id: string;
}): Promise<Map<string, Date>> {
  const pendingTxs = await prisma.pendingMultisigTransaction.findMany({
    where: { treasuryId: treasury.id },
    select: { signedByJson: true, updatedAt: true, createdAt: true },
    orderBy: { updatedAt: 'desc' },
  });

  const lastActive = new Map<string, Date>();
  for (const tx of pendingTxs) {
    const when = tx.updatedAt ?? tx.createdAt;
    const signedBy = Array.isArray(tx.signedByJson) ? (tx.signedByJson as unknown[]) : [];
    for (const entry of signedBy) {
      const key = typeof entry === 'string' ? entry : (entry as any)?.key;
      if (typeof key === 'string' && !lastActive.has(key)) {
        lastActive.set(key, when);
      }
    }
  }
  return lastActive;
}

export async function runMultisigInactivityWatcher(
  resolveActivity: SignerActivityResolver = resolveActivityFromPendingTxs,
) {
  console.log('[MultisigInactivity] 🚀 Starting Multi-Sig Signer Inactivity Watcher...');

  const poll = async () => {
    if (isProcessing) {
      console.log('[MultisigInactivity] ⏳ Previous cycle still running. Skipping this pass.');
      return;
    }
    isProcessing = true;
    try {
      await runMultisigInactivityPass(resolveActivity);
    } catch (error: any) {
      console.error('[MultisigInactivity] Polling pass error:', error?.message || error);
    } finally {
      isProcessing = false;
    }
  };

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runMultisigInactivityWatcher();
}
