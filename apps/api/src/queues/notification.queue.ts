import { Queue } from 'bullmq';

const connection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379',
};

export const notificationQueue = new Queue('notification', { connection });

export async function enqueueNotificationJob(paymentId: string) {
  await notificationQueue.add('send-notification', { paymentId });
}
