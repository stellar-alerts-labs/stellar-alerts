import https from "node:https";
import { Worker, type ConnectionOptions } from "bullmq";
import { redis, registerRedisCleanupTask } from "../lib/redis";
import { createLogger } from "../lib/logger";
import {
  QueueLaneManager,
  type QueueLane,
  QUEUE_LANE_CONFIGS,
  resolveLaneForAlert,
} from "../lib/queue-lanes";
import {
  fairShareQueueScheduler,
  SUBSCRIBER_TIERS,
} from "../lib/queue/fair-scheduler";
import {
  RedisCircuitBreaker,
  CircuitBreakerOpenError,
} from "../modules/alerts/circuit-breaker";
import { isChatSnoozed } from "../modules/telegram/commands/snooze";
import { webhookTelemetry } from "../modules/webhooks/webhook-telemetry";
import {
  ssrfFilter,
  SsrfFilter,
  SsrfBlockedError,
  type PinnedWebhookTarget,
} from "../modules/webhooks/ssrf-filter";
import { alertStormBundler } from "../modules/notifications/storm-bundler";

const log = createLogger({ module: "WebhookDispatcherWorker" });

export interface WebhookDispatchJobData {
  webhookId: string;
  url: string;
  payload: Record<string, any>;
  headers?: Record<string, string>;
  traceparent?: string;
  paymentId?: string;
  /** Priority lane hint. If omitted, lane is derived from severity metadata. */
  lane?: QueueLane;
  /** Severity of the underlying alert rule (critical/high/standard/bulk). */
  severity?: string;
  /** Tenant/subscriber ID for fair scheduling */
  tenantId?: string;
  /** Subscriber tier for rate limiting (free/professional/enterprise) */
  subscriberTier?: string;
  /** Rule ID for alert storm bundling */
  ruleId?: string;
  /** Alert metadata for bundling (amount, fromAddress, etc.) */
  alertData?: Record<string, any>;
}

export interface WebhookDispatchResult {
  webhookId: string;
  status: "delivered" | "skipped" | "failed";
  statusCode?: number;
  durationMs?: number;
  reason?: string;
  pinnedIp?: string;
  lane?: QueueLane;
}

export type WebhookTransportFn = (
  url: string,
  payload: string,
  headers: Record<string, string>,
  pinnedTarget?: PinnedWebhookTarget,
) => Promise<{ status: number; body?: string }>;

export class DispatcherWorker {
  private circuitBreaker: RedisCircuitBreaker;
  private workers: Map<QueueLane, Worker<WebhookDispatchJobData>> = new Map();
  private transport: WebhookTransportFn;
  private ssrfFilter: SsrfFilter;
  private laneManager: QueueLaneManager;

  constructor(
    circuitBreaker?: RedisCircuitBreaker,
    transport?: WebhookTransportFn,
    filter?: SsrfFilter,
    laneManager?: QueueLaneManager,
  ) {
    this.circuitBreaker = circuitBreaker || new RedisCircuitBreaker();
    this.transport = transport || this.defaultTransport.bind(this);
    this.ssrfFilter = filter || ssrfFilter;
    this.laneManager = laneManager || new QueueLaneManager();
  }

  private async defaultTransport(
    url: string,
    payload: string,
    headers: Record<string, string>,
    pinnedTarget?: PinnedWebhookTarget,
  ) {
    const target =
      pinnedTarget ?? (await this.ssrfFilter.validateAndResolve(url));

    if (target.parsedUrl.protocol === "http:") {
      const res = await fetch(target.pinnedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: target.hostHeader,
          "X-Validated-Egress-IP": target.pinnedIp,
          ...headers,
        },
        body: payload,
        redirect: "manual",
      });
      return { status: res.status, body: await res.text() };
    }

    return this.postHttpsPinned(target, payload, headers);
  }

  /** HTTPS POST that connects ONLY to the already-validated IP (stops DNS rebinding). */
  private postHttpsPinned(
    target: PinnedWebhookTarget,
    payload: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body?: string }> {
    return new Promise((resolve, reject) => {
      const { parsedUrl, pinnedIp } = target;
      const family = pinnedIp.includes(":") ? 6 : 4;

      const req = https.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: parsedUrl.pathname + parsedUrl.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            ...headers,
          },
          // Always connect to the validated IP, never re-resolve DNS.
          lookup: (_host: string, opts: any, cb: any) => {
            if (opts && opts.all)
              return cb(null, [{ address: pinnedIp, family }]);
            return cb(null, pinnedIp, family);
          },
          timeout: 10000,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );

      req.on("timeout", () =>
        req.destroy(new Error("Webhook request timed out")),
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Processes a single webhook dispatch job.
   * 1. Applies alert storm bundling to prevent fatigue during batch payouts.
   * 2. Checks fair scheduling limits per tenant.
   * 3. Checks circuit breaker state.
   * 4. Validates target URL and resolves/pins IP via SsrfFilter (rejecting private/internal IPs).
   * 5. Dispatches webhook with pinned IP target.
   */
  public async processJob(job: {
    data: WebhookDispatchJobData;
  }): Promise<WebhookDispatchResult> {
    const {
      webhookId,
      url,
      payload,
      headers = {},
      paymentId,
      tenantId,
      subscriberTier,
      ruleId,
      alertData,
      severity,
    } = job.data;
    const lane: QueueLane = job.data.lane ?? resolveLaneForAlert(job.data);

    // Apply alert storm bundling if ruleId is present
    if (ruleId && alertData) {
      const stormResult = alertStormBundler.processAlert({
        ruleId,
        severity: severity || "standard",
        alert: alertData,
      });

      if (!stormResult.dispatch && stormResult.bundle) {
        // Alert exceeds threshold; defer for bundling
        log.debug(
          { webhookId, ruleId, totalCount: stormResult.bundle.totalCount },
          "Alert deferred: exceeds storm threshold, bundling with similar alerts",
        );
        return {
          webhookId,
          status: "skipped",
          reason: "deferred_for_bundling",
          lane,
        };
      }
    }

    // Fair scheduling check: prevent tenant monopolization
    if (tenantId) {
      const tierName = subscriberTier || "professional";
      const tier = SUBSCRIBER_TIERS[tierName] || SUBSCRIBER_TIERS.professional;

      const canSchedule = await fairShareQueueScheduler.canScheduleJob(
        tenantId,
        tierName,
        0,
      );

      if (!canSchedule.canProcess) {
        log.debug(
          { webhookId, tenantId, waitTimeMs: canSchedule.waitTimeMs, lane },
          "⏳ Webhook deferred due to subscriber rate limit",
        );
        // Defer this job with exponential backoff
        const delayMs = Math.min(canSchedule.waitTimeMs, 5000) + 100;
        throw new Error(`Rate limited, retry after ${delayMs}ms`);
      }
    }

    // Check circuit breaker state first
    const canSend = await this.circuitBreaker.canExecute(webhookId);
    if (!canSend) {
      log.warn(
        { webhookId, url, lane },
        `[DispatcherWorker] Circuit breaker OPEN for webhook ${webhookId}; skipping network call`,
      );
      return {
        webhookId,
        status: "skipped",
        reason: "circuit_breaker_open",
        lane,
      };
    }

    // Check if destination Telegram chat is currently snoozed (#896)
    const tgChatId =
      payload?.telegramChatId ||
      payload?.chat_id ||
      (job.data as any).telegramChatId;
    if (tgChatId && (await isChatSnoozed(String(tgChatId)))) {
      log.info(
        { webhookId, chatId: tgChatId, lane },
        "[DispatcherWorker] Telegram destination chat is snoozed; skipping delivery",
      );
      return {
        webhookId,
        status: "skipped",
        reason: "telegram_chat_snoozed",
        lane,
      };
    }

    let pinnedTarget: PinnedWebhookTarget;
    try {
      pinnedTarget = await this.ssrfFilter.validateAndResolve(url);
    } catch (err: any) {
      const statusCode = err instanceof SsrfBlockedError ? err.statusCode : 400;
      log.error(
        { webhookId, url, reason: err.reason ?? err.message, statusCode, lane },
        "[SECURITY_AUDIT] Blocked webhook dispatch due to SSRF egress policy",
      );
      return {
        webhookId,
        status: "failed",
        statusCode,
        reason: err.message,
        lane,
      };
    }

    try {
      const payloadStr = JSON.stringify(payload);
      const { result: res, durationMs } =
        await webhookTelemetry.measureDispatch(
          webhookId,
          url,
          async () => {
            return await this.circuitBreaker.execute(webhookId, async () => {
              const response = await this.transport(
                url,
                payloadStr,
                headers,
                pinnedTarget,
              );
              if (response.status >= 500) {
                const err: any = new Error(
                  `Server returned HTTP ${response.status}`,
                );
                err.statusCode = response.status;
                throw err;
              }
              return response;
            });
          },
          paymentId,
        );

      return {
        webhookId,
        status: "delivered",
        statusCode: res.status,
        durationMs,
        pinnedIp: pinnedTarget.pinnedIp,
        lane,
      };
    } catch (err: any) {
      if (err instanceof CircuitBreakerOpenError) {
        log.warn(
          { webhookId, lane },
          "Fast-fail: circuit breaker opened during dispatch",
        );
        return {
          webhookId,
          status: "skipped",
          reason: "circuit_breaker_open",
          lane,
        };
      }

      log.error(
        { webhookId, lane, err: err.message },
        "Webhook delivery failed",
      );
      return {
        webhookId,
        status: "failed",
        reason: err.message,
        lane,
      };
    }
  }

  /**
   * Starts dedicated workers for each priority lane.
   *
   * Each lane gets its own BullMQ Worker bound to its lane-specific queue name,
   * so critical jobs are never head-of-line blocked behind bulk jobs. The
   * concurrency for each lane is taken from QUEUE_LANE_CONFIGS, which guarantees
   * minimum capacity for critical/high lanes.
   */
  public start(baseQueueName = "webhook-dispatch") {
    for (const lane of Object.keys(QUEUE_LANE_CONFIGS) as QueueLane[]) {
      const config = QUEUE_LANE_CONFIGS[lane];
      const queueName = this.laneManager.getQueueName(lane, baseQueueName);
      const worker = new Worker<WebhookDispatchJobData>(
        queueName,
        async (job) => this.processJob(job),
        {
          connection: redis as unknown as ConnectionOptions,
          concurrency: config.concurrency,
        },
      );

      worker.on("failed", (job, error) => {
        log.error(
          { lane, jobId: job?.id, err: error.message },
          "Webhook dispatch job failed in lane",
        );
      });

      this.workers.set(lane, worker);
      log.info(
        { lane, queueName, concurrency: config.concurrency },
        "Started priority lane dispatcher worker",
      );
    }

    registerRedisCleanupTask(async () => {
      await Promise.all(
        Array.from(this.workers.values()).map((w) => w.close()),
      );
      this.workers.clear();
    });

    return this.workers;
  }

  /** Returns the worker for a specific lane (if started). */
  public getWorker(
    lane: QueueLane,
  ): Worker<WebhookDispatchJobData> | undefined {
    return this.workers.get(lane);
  }

  /** Returns the lane manager used by this worker (for metrics/integration tests). */
  public getLaneManager(): QueueLaneManager {
    return this.laneManager;
  }

  /** Returns fair scheduling statistics */
  public getFairSchedulingStats() {
    return fairShareQueueScheduler.getStats();
  }
}

export const dispatcherWorker = new DispatcherWorker();
