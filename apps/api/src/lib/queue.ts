import { Queue, QueueEvents, Job, Worker } from 'bullmq';
import { Resend } from 'resend';
import { createLogger } from './logger';

const queueLog = createLogger({ module: 'Queue' });

export interface AlertJobData {
  paymentId: string;
  txHash: string;
  walletId: string;
  amount: string;
  asset: string;
  assetIssuer?: string | null;
  fromAddress: string;
  receivedAt: string;
  /** Correlation ID propagated from the originating HTTP request, if any. */
  requestId?: string;
}

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

export let alertQueue: Queue<AlertJobData> | null = null;
export let dlqQueue: Queue<AlertJobData> | null = null;
export let alertQueueEvents: QueueEvents | null = null;
export let alertWorker: Worker<AlertJobData> | null = null;

const resend = new Resend(process.env.RESEND_API_KEY || 're_123');

try {
  const connection = {
    host: redisHost,
    port: redisPort,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  };

  alertQueue = new Queue<AlertJobData>('payment-alerts', {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  dlqQueue = new Queue<AlertJobData>('payment-alerts-dlq', { connection });
  alertQueueEvents = new QueueEvents('payment-alerts', { connection });

  alertWorker = new Worker<AlertJobData>('payment-alerts', async (job) => {
    const data = job.data;
    // Bind the correlation ID from the enqueuing request so every log line
    // produced during job processing shares the same requestId.
    const jobLog = createLogger({ module: 'AlertWorker', requestId: data.requestId });

    const { data: resendData, error } = await resend.emails.send({
      from: 'Stellar Alerts <alerts@resend.dev>',
      to: [data.fromAddress],
      subject: `Payment Receipt: ${data.amount} ${data.asset}`,
      html: `
        <h1>Payment Receipt</h1>
        <p><strong>Payment ID:</strong> ${data.paymentId}</p>
        <p><strong>Transaction Hash:</strong> ${data.txHash}</p>
        <p><strong>Amount:</strong> ${data.amount} ${data.asset}</p>
        <p><strong>From Address:</strong> ${data.fromAddress}</p>
        <p><strong>Received At:</strong> ${data.receivedAt}</p>
      `,
    });

    if (error) {
      throw new Error(`Resend Error: ${error.message}`);
    }

    jobLog.info({ paymentId: data.paymentId }, 'Sent email receipt');
    return resendData;
  }, { connection });

  alertQueueEvents.on('failed', async ({ jobId, failedReason }) => {
    if (!jobId || !alertQueue || !dlqQueue) return;
    try {
      const job = await Job.fromId(alertQueue, jobId);
      if (job && job.attemptsMade >= (job.opts.attempts || 5)) {
        await dlqQueue.add('dispatch-alert-failed', job.data, {
          jobId: `dlq-${jobId}`,
        });
        queueLog.warn({ jobId, failedReason }, 'Moved failed job to DLQ');
      }
    } catch (e: any) {
      queueLog.warn({ jobId, err: e.message }, 'Could not route job to DLQ');
    }
  });

  queueLog.info({ host: redisHost, port: redisPort }, '📡 BullMQ payment-alerts queue initialized');
} catch (err: any) {
  queueLog.warn({ err: err.message }, 'Could not initialize BullMQ queue');
}

export async function enqueuePaymentAlert(data: AlertJobData) {
  if (!alertQueue) {
    queueLog.info({ txHash: data.txHash }, 'Skipping queue enqueue (Queue not connected)');
    return null;
  }

  try {
    const job = await alertQueue.add('dispatch-alert', data, {
      jobId: `payment-${data.txHash}`,
    });
    queueLog.info({ jobId: job.id, txHash: data.txHash, requestId: data.requestId }, '📨 Enqueued payment alert job');
    return job;
  } catch (err: any) {
    queueLog.warn({ txHash: data.txHash, err: err.message }, 'Failed to enqueue alert');
    return null;
  }
}
