import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { sendTelegramMessage } from '../lib/telegram';

const prisma = new PrismaClient();

const connection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379',
};

export const notifyWorker = new Worker(
  'notification',
  async (job) => {
    const { paymentId } = job.data;
    console.log(`[NotifyWorker] Processing notification for payment ${paymentId}`);

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        wallet: {
          include: {
            user: {
              include: {
                notifyPrefs: true,
              },
            },
          },
        },
      },
    });

    if (!payment) {
      console.warn(`[NotifyWorker] Payment ${paymentId} not found.`);
      return;
    }

    const prefs = payment.wallet.user.notifyPrefs;
    if (!prefs) {
      console.log(`[NotifyWorker] User ${payment.wallet.user.id} has no notification preferences.`);
      return;
    }

    if (prefs.telegramEnabled && prefs.telegramChatId) {
      const message = `🚀 *New Payment Received!*\n\n*Amount:* ${payment.amount} ${payment.asset}\n*Wallet:* \`${payment.wallet.publicKey}\`\n*From:* \`${payment.fromAddress}\``;
      await sendTelegramMessage(prefs.telegramChatId, message);
      console.log(`[NotifyWorker] Telegram notification sent to chat ID ${prefs.telegramChatId}`);
    }

    // Email and WhatsApp logic can be added here
  },
  { connection }
);

notifyWorker.on('failed', (job, err) => {
  console.error(`[NotifyWorker] Job ${job?.id} failed:`, err);
});

console.log('[NotifyWorker] Started notification worker');
