import { PrismaClient } from '@prisma/client';
import { stellar } from '../lib/stellar';

const prisma = new PrismaClient();

export async function runWatcher() {
  console.log('[WatcherWorker] Starting Stellar testnet watcher...');

  // Simple polling loop
  setInterval(async () => {
    try {
      const wallets = await prisma.wallet.findMany();
      if (wallets.length === 0) return;

      for (const wallet of wallets) {
        // Fetch latest payments
        const records = await stellar.getRecentPayments(wallet.publicKey, 5);

        for (const record of records) {
          if (record.type === 'payment') {
            const amount = record.amount;
            const asset = record.asset_type === 'native' ? 'XLM' : record.asset_code;
            const fromAddress = record.from;
            const txHash = record.transaction_hash;
            const receivedAt = new Date(record.created_at);

            // Attempt to insert
            // Using upsert or unique constraint on txHash to avoid duplicates
            // We should ideally check if it already exists to avoid throwing unique constraint errors constantly
            const existing = await prisma.payment.findUnique({ where: { txHash } });
            if (!existing) {
              console.log(`[WatcherWorker] New payment found for wallet ${wallet.id}: ${amount} ${asset}`);
              const payment = await prisma.payment.create({
                data: {
                  walletId: wallet.id,
                  txHash,
                  fromAddress,
                  amount: Number(amount),
                  asset: asset || 'Unknown',
                  receivedAt,
                  // memo could be fetched from the transaction, omitted for simplicity
                }
              });

              const { enqueueNotificationJob } = require('../queues/notification.queue');
              await enqueueNotificationJob(payment.id);
            }
          }
        }
      }
    } catch (error) {
      console.error('[WatcherWorker] Polling error:', error);
    }
  }, 10000); // Poll every 10 seconds
}

// If this file is run directly, start the watcher
if (require.main === module) {
  runWatcher();
}
