import { Queue, QueueEvents, Job, Worker } from "bullmq";
import { Resend } from "resend";
import CircuitBreaker from "opossum";
import { prisma } from "./prisma";
import { generateWebhookSignature } from "../utils/webhook-signer";

export interface AlertJobData {
  paymentId: string;
  txHash: string;
  walletId: string;
  amount: string;
  asset: string;
  assetIssuer?: string | null;
  fromAddress: string;
  receivedAt: string;
}

const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);
const WEBHOOK_TIMEOUT_MS = 10000;
const CIRCUIT_BREAKER_THRESHOLD = 10; // 10 consecutive 5xx failures opens circuit
const CIRCUIT_BREAKER_TIMEOUT = 60000; // 60 second timeout before half-open

export let alertQueue: Queue<AlertJobData> | null = null;
export let dlqQueue: Queue<AlertJobData> | null = null;
export let alertQueueEvents: QueueEvents | null = null;
export let alertWorker: Worker<AlertJobData> | null = null;

const resend = new Resend(process.env.RESEND_API_KEY || "re_123");
const circuitBreakers = new Map<string, CircuitBreaker<any>>();

async function getOrCreateCircuitBreaker(
  webhookId: string,
): Promise<CircuitBreaker<any>> {
  if (circuitBreakers.has(webhookId)) {
    return circuitBreakers.get(webhookId)!;
  }

  const breaker = new CircuitBreaker(
    async (url: string, payload: string, headers: Record<string, string>) => {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      if (response.status >= 500) {
        throw new Error(`Server error: ${response.status}`);
      }

      return response;
    },
    {
      timeout: WEBHOOK_TIMEOUT_MS,
      errorThresholdPercentage: 100,
      volumeThreshold: CIRCUIT_BREAKER_THRESHOLD,
      rollingCountTimeout: 60000,
      name: `webhook-${webhookId}`,
    },
  );

  circuitBreakers.set(webhookId, breaker);
  return breaker;
}

async function updateCircuitBreakerState(
  webhookId: string,
  state: "closed" | "open" | "half-open",
  failureCount: number = 0,
) {
  await prisma.webhookCircuitBreaker.upsert({
    where: { webhookId },
    create: {
      webhookId,
      state,
      failureCount,
      openedAt: state === "open" ? new Date() : null,
    },
    update: {
      state,
      failureCount,
      lastFailureAt: state === "open" ? new Date() : undefined,
      openedAt: state === "open" ? new Date() : undefined,
    },
  });
}

export async function dispatchWebhookAndLog(webhookId: string, payload: any) {
  try {
    const webhook = await prisma.webhook.findUnique({
      where: { id: webhookId },
      include: { circuitBreaker: true },
    });

    if (!webhook) {
      console.warn(`[WebhookDispatch] Webhook ${webhookId} not found`);
      return;
    }

    // Check circuit breaker state
    if (webhook.circuitBreaker?.state === "open") {
      const openedAt = webhook.circuitBreaker.openedAt?.getTime() || 0;
      const now = Date.now();

      if (now - openedAt < CIRCUIT_BREAKER_TIMEOUT) {
        console.warn(
          `[WebhookDispatch] Circuit breaker OPEN for webhook ${webhookId}, skipping dispatch`,
        );
        await prisma.webhookLog.create({
          data: {
            webhookId,
            error: "Circuit breaker is open, endpoint temporarily disabled",
          },
        });
        return;
      } else {
        // Transition to half-open
        await updateCircuitBreakerState(webhookId, "half-open");
        console.log(
          `[WebhookDispatch] Circuit breaker HALF-OPEN for webhook ${webhookId}, attempting recovery`,
        );
      }
    }

    const payloadString = JSON.stringify(payload);
    const signature = generateWebhookSignature(payloadString, webhook.secret);

    const breaker = await getOrCreateCircuitBreaker(webhookId);
    const response = await breaker.fire(webhook.url, payloadString, {
      "Content-Type": "application/json",
      "X-Stellar-Signature": signature.headerValue,
    });

    const responseBody = await response.text();

    await prisma.webhookLog.create({
      data: {
        webhookId,
        statusCode: response.status,
        responseBody: responseBody.substring(0, 5000),
      },
    });

    // Reset circuit breaker to closed on success
    if (webhook.circuitBreaker?.state === "half-open") {
      await updateCircuitBreakerState(webhookId, "closed", 0);
      console.log(
        `[WebhookDispatch] Circuit breaker CLOSED for webhook ${webhookId}, service recovered`,
      );
    }

    console.log(
      `[WebhookDispatch] Webhook ${webhookId} dispatched, status: ${response.status}`,
    );
  } catch (error: any) {
    // Handle circuit breaker open error
    if (error.message && error.message.includes("breaker is open")) {
      console.warn(
        `[WebhookDispatch] Circuit breaker prevented request for webhook ${webhookId}`,
      );
      await prisma.webhookLog.create({
        data: {
          webhookId,
          error: "Circuit breaker is open",
        },
      });
      return;
    }

    // Track consecutive failures
    const breaker = circuitBreakers.get(webhookId);
    let failureCount = 1;

    if (breaker && typeof breaker.stats === "object") {
      const stats = breaker.stats();
      failureCount = stats?.failures || 1;
    }

    // Open circuit if threshold reached
    if (failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
      await updateCircuitBreakerState(webhookId, "open", failureCount);
      console.error(
        `[WebhookDispatch] Circuit breaker OPENED for webhook ${webhookId} after ${failureCount} failures`,
      );
    } else {
      await updateCircuitBreakerState(webhookId, "closed", failureCount);
    }

    await prisma.webhookLog.create({
      data: {
        webhookId,
        error: error.message.substring(0, 1000),
      },
    });

    console.error(
      `[WebhookDispatch] Failed to dispatch webhook ${webhookId}: ${error.message}`,
    );
  }
}

export const paymentAlertWorkerProcessor = async (job: { data: AlertJobData }) => {
  const data = job.data;
  
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
  
  console.log(`[Worker] Sent email receipt for ${data.paymentId}`);

  try {
    const payment = await prisma.payment.findUnique({
      where: { id: data.paymentId },
      include: { wallet: { include: { user: { include: { notifyPrefs: true } } } } }
    });

    if (payment?.wallet?.user?.notifyPrefs?.telegramEnabled && payment.wallet.user.notifyPrefs.telegramChatId) {
      const chatId = payment.wallet.user.notifyPrefs.telegramChatId;
      const botToken = process.env.TELEGRAM_BOT_TOKEN || 'mock_token';
      const message = `Payment Receipt:\nAmount: ${data.amount} ${data.asset}\nFrom: ${data.fromAddress}`;
      
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message })
      });
      
      if (!response.ok) {
        console.warn(`[Worker] Failed to send Telegram message for ${data.paymentId}`);
      } else {
        console.log(`[Worker] Sent Telegram receipt for ${data.paymentId}`);
      }
    }
  } catch (dbErr: any) {
    console.warn(`[Worker] Failed to check Telegram preferences for ${data.paymentId}: ${dbErr.message}`);
  }

  return resendData;
};

try {
  const connection = {
    host: redisHost,
    port: redisPort,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  };

  alertQueue = new Queue<AlertJobData>("payment-alerts", {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  dlqQueue = new Queue<AlertJobData>("payment-alerts-dlq", { connection });
  alertQueueEvents = new QueueEvents("payment-alerts", { connection });

  alertWorker = new Worker<AlertJobData>(
    "payment-alerts",
    async (job) => {
      const data = job.data;

      // Get user's active webhooks
      const wallet = await prisma.wallet.findUnique({
        where: { id: data.walletId },
        include: {
          user: {
            include: {
              webhooks: {
                where: { isActive: true },
              },
            },
          },
        },
      });

      // Prepare webhook payload
      const webhookPayload = {
        event: "payment.received",
        timestamp: new Date().toISOString(),
        data: {
          paymentId: data.paymentId,
          txHash: data.txHash,
          amount: data.amount,
          asset: data.asset,
          assetIssuer: data.assetIssuer,
          fromAddress: data.fromAddress,
          receivedAt: data.receivedAt,
        },
      };

      // Dispatch to all user webhooks (non-blocking)
      if (wallet?.user?.webhooks) {
        await Promise.all(
          wallet.user.webhooks.map((webhook) =>
            dispatchWebhookAndLog(webhook.id, webhookPayload),
          ),
        ).catch((err) => {
          console.warn(`[Worker] Webhook dispatch had errors: ${err.message}`);
        });
      }

      // Send email alert
      const { data: resendData, error } = await resend.emails.send({
        from: "Stellar Alerts <alerts@resend.dev>",
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

      console.log(`[Worker] Sent email receipt for ${data.paymentId}`);
      return resendData;
    },
    { connection },
  );

  if (alertQueueEvents) {
    alertQueueEvents.on("failed", failedJobHandler);
  }

  console.log(
    `[Queue] 📡 BullMQ payment-alerts queue initialized (${redisHost}:${redisPort})`,
  );
} catch (err: any) {
  console.warn(`[Queue] Could not initialize BullMQ queue: ${err.message}`);
}

export async function failedJobHandler({ jobId, failedReason }: { jobId?: string; failedReason?: string }) {
  if (!jobId || !alertQueue || !dlqQueue) return;
  try {
    const job = await Job.fromId(alertQueue, jobId);
    if (job && job.attemptsMade >= (job.opts.attempts || 5)) {
      await dlqQueue.add("dispatch-alert-failed", job.data, {
        jobId: `dlq-${jobId}`,
      });
      console.log(
        `[Queue] 📨 Moved failed job ${jobId} to DLQ. Reason: ${failedReason}`,
      );
    }
  } catch (err: any) {
    console.warn(`[Queue] Failed to process DLQ routing for ${jobId}: ${err.message}`);
  }
}

export async function enqueuePaymentAlert(data: AlertJobData) {
  if (!alertQueue) {
    console.log(
      `[Queue] Skipping queue enqueue for payment ${data.txHash} (Queue not connected)`,
    );
    return null;
  }

  try {
    const job = await alertQueue.add("dispatch-alert", data, {
      jobId: `payment-${data.txHash}`,
    });
    console.log(`[Queue] 📨 Enqueued payment alert job: ${job.id}`);
    return job;
  } catch (err: any) {
    console.warn(
      `[Queue] Failed to enqueue alert for payment ${data.txHash}: ${err.message}`,
    );
    return null;
  }
}

export { dispatchPushNotification } from "../utils/push-protocol";

