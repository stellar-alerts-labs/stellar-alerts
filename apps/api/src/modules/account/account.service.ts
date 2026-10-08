import { prisma } from '../../lib/prisma';
import { generateLedgerStatementCsv } from '../../utils/csv-generator';

/**
 * Account lifecycle service.
 *
 * Covers the two privacy-preserving workflows mandated by issue #320:
 *   1. exportAccount — builds a portable data dump (JSON + CSV) for the
 *      authenticated user containing all personally identifiable data the
 *      platform holds about them.
 *   2. deleteAccount — orchestrates a hard, cascading deletion of every
 *      record linked to the user: wallets (and their cursors / payments),
 *      notification preferences, webhooks (logs + circuit breakers),
 *      Soroban subscriptions, multisig watcher entries, anchor watches,
 *      DEX swap watches, and finally the user row itself.
 *
 * Both operations require the caller to be authenticated; the controller
 * verifies `request.user` before invoking these methods.
 */
export class AccountService {
  // ── Export ───────────────────────────────────────────────────────────────

  /**
   * Assembles a full data export for the given user.
   *
   * Returns a structured object that the controller can serialise to JSON and
   * also a CSV string of payment history for spreadsheet-compatible download.
   */
  async exportAccount(userId: string): Promise<AccountExport> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallets: {
          include: {
            payments: {
              orderBy: { receivedAt: 'desc' },
            },
            cursor: true,
          },
        },
        webhooks: {
          include: {
            logs: { orderBy: { sentAt: 'desc' }, take: 100 },
            circuitBreaker: true,
          },
        },
        notifyPrefs: true,
        sorobanSubscriptions: true,
        multisigSignerWatches: {
          include: { treasury: true },
        },
        anchorWatches: true,
        dexSwapWatches: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Flatten payments across all wallets for the CSV.
    const allPayments = user.wallets.flatMap((w) =>
      w.payments.map((p) => ({
        txHash: p.txHash,
        fromAddress: p.fromAddress,
        amount: String(p.amount),
        asset: p.asset,
        receivedAt: p.receivedAt,
      })),
    );

    const paymentsCsv = generateLedgerStatementCsv(allPayments);

    return {
      exportedAt: new Date().toISOString(),
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt.toISOString(),
      },
      wallets: user.wallets.map((w) => ({
        id: w.id,
        publicKey: w.publicKey,
        label: w.label ?? null,
        createdAt: w.createdAt.toISOString(),
        payments: w.payments.map((p) => ({
          id: p.id,
          txHash: p.txHash,
          fromAddress: p.fromAddress,
          amount: String(p.amount),
          asset: p.asset,
          assetIssuer: p.assetIssuer ?? null,
          memo: p.memo ?? null,
          receivedAt: p.receivedAt.toISOString(),
        })),
      })),
      notificationPreferences: user.notifyPrefs ?? null,
      webhooks: user.webhooks.map((wh) => ({
        id: wh.id,
        url: wh.url,
        isActive: wh.isActive,
        createdAt: wh.createdAt.toISOString(),
        recentLogs: wh.logs,
      })),
      sorobanSubscriptions: user.sorobanSubscriptions,
      multisigWatches: user.multisigSignerWatches,
      anchorWatches: user.anchorWatches,
      dexSwapWatches: user.dexSwapWatches,
      paymentsCsv,
    };
  }

  // ── Deletion ─────────────────────────────────────────────────────────────

  /**
   * Permanently deletes all data associated with `userId` in a single
   * Prisma interactive transaction.
   *
   * Deletion order respects FK constraints (children before parents):
   *   1. WebhookLog → WebhookCircuitBreaker → Webhook
   *   2. Payment → IngestionCursor → Wallet
   *   3. NotificationPreference
   *   4. SorobanContractSubscription
   *   5. MultisigSignerWatcher (treasury rows are shared; only the user-link rows)
   *   6. AnchorTransactionWatch
   *   7. DexSwapWatch
   *   8. User
   *
   * Returns a summary of deleted record counts for audit logging.
   */
  async deleteAccount(userId: string): Promise<DeletionSummary> {
    return prisma.$transaction(async (tx) => {
      // 1a. Webhook logs for all the user's webhooks.
      const userWebhooks = await tx.webhook.findMany({
        where: { userId },
        select: { id: true },
      });
      const webhookIds = userWebhooks.map((w) => w.id);

      const { count: logsDeleted } = await tx.webhookLog.deleteMany({
        where: { webhookId: { in: webhookIds } },
      });

      // 1b. Circuit breakers.
      const { count: circuitBreakersDeleted } = await tx.webhookCircuitBreaker.deleteMany({
        where: { webhookId: { in: webhookIds } },
      });

      // 1c. Webhooks.
      const { count: webhooksDeleted } = await tx.webhook.deleteMany({
        where: { userId },
      });

      // 2a. Payments for all the user's wallets.
      const userWallets = await tx.wallet.findMany({
        where: { userId },
        select: { id: true },
      });
      const walletIds = userWallets.map((w) => w.id);

      const { count: paymentsDeleted } = await tx.payment.deleteMany({
        where: { walletId: { in: walletIds } },
      });

      // 2b. Ingestion cursors (cascade on wallet delete, but explicit for clarity).
      const { count: cursorsDeleted } = await tx.ingestionCursor.deleteMany({
        where: { walletId: { in: walletIds } },
      });

      // 2c. Wallets.
      const { count: walletsDeleted } = await tx.wallet.deleteMany({
        where: { userId },
      });

      // 3. Notification preferences.
      const { count: prefsDeleted } = await tx.notificationPreference.deleteMany({
        where: { userId },
      });

      // 4. Soroban subscriptions.
      const { count: sorobanDeleted } = await tx.sorobanContractSubscription.deleteMany({
        where: { userId },
      });

      // 5. Multisig signer watcher entries (not the shared treasury rows).
      const { count: multisigDeleted } = await tx.multisigSignerWatcher.deleteMany({
        where: { userId },
      });

      // 6. Anchor transaction watches.
      const { count: anchorDeleted } = await tx.anchorTransactionWatch.deleteMany({
        where: { userId },
      });

      // 7. DEX swap watches.
      const { count: dexDeleted } = await tx.dexSwapWatch.deleteMany({
        where: { userId },
      });

      // 8. User row — must be last.
      await tx.user.delete({ where: { id: userId } });

      return {
        deletedAt: new Date().toISOString(),
        userId,
        counts: {
          webhookLogs: logsDeleted,
          webhookCircuitBreakers: circuitBreakersDeleted,
          webhooks: webhooksDeleted,
          payments: paymentsDeleted,
          ingestionCursors: cursorsDeleted,
          wallets: walletsDeleted,
          notificationPreferences: prefsDeleted,
          sorobanSubscriptions: sorobanDeleted,
          multisigWatches: multisigDeleted,
          anchorWatches: anchorDeleted,
          dexSwapWatches: dexDeleted,
          users: 1,
        },
      };
    });
  }
}

// ── Exported types ──────────────────────────────────────────────────────────

export interface AccountExport {
  exportedAt: string;
  user: { id: string; email: string; createdAt: string };
  wallets: Array<{
    id: string;
    publicKey: string;
    label: string | null;
    createdAt: string;
    payments: Array<{
      id: string;
      txHash: string;
      fromAddress: string;
      amount: string;
      asset: string;
      assetIssuer: string | null;
      memo: string | null;
      receivedAt: string;
    }>;
  }>;
  notificationPreferences: Record<string, unknown> | null;
  webhooks: Array<{
    id: string;
    url: string;
    isActive: boolean;
    createdAt: string;
    recentLogs: unknown[];
  }>;
  sorobanSubscriptions: unknown[];
  multisigWatches: unknown[];
  anchorWatches: unknown[];
  dexSwapWatches: unknown[];
  paymentsCsv: string;
}

export interface DeletionSummary {
  deletedAt: string;
  userId: string;
  counts: Record<string, number>;
}

export const accountService = new AccountService();
