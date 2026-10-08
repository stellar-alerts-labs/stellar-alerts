import { prisma } from '../../lib/prisma';
import { cryptoVault } from '../../utils/crypto-vault';
import { KeyRotationManager } from '../../utils/key-rotation-manager';
import { buildWebhookSandboxEnvelope } from './dead-letters.envelope';
import type { SandboxMockResponse } from './dead-letters.schema';

/**
 * What the in-process sandbox receiver observed for one replay.
 */
export interface SandboxRequestObservation {
  /** Canonical webhook envelope a real receiver would have parsed. */
  envelope: Record<string, unknown> | null;
  /** Exact JSON body bytes delivered to the receiver. */
  body: string;
  /** All request headers the receiver saw, including live signatures. */
  headers: Record<string, string>;
}

/**
 * What the sandbox receiver answered with.
 */
export interface SandboxResponseObservation {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
}

export interface SandboxReplayResult {
  success: boolean;
  replay: {
    id: string;
    status: 'completed' | 'failed';
    request: SandboxRequestObservation;
    response: SandboxResponseObservation;
    /** End-to-end wall-clock duration of the synthetic request, in ms. */
    durationMs: number;
    error: string | null;
    createdAt: Date;
  };
}

const SANDBOX_REPLAY_TYPE = 'sandbox-replay';
const SANDBOX_KEY_ID = 'webhook-sandbox-replay';

export class WebhookSandboxService {
  /**
   * Replays a dead letter against the in-process sandbox receiver.
   *
   * The receiver never performs network I/O: it is a pure function of the
   * recorded request plus the caller-supplied mock response, so replays are
   * deterministic, instant, and safe to run repeatedly without risking real
   * double-delivery. The dispatch pipeline (and therefore the idempotency
   * machinery) is NOT invoked — this is a dry, observable dispatch.
   */
  async replaySandbox(
    id: string,
    userId: string,
    mock: SandboxMockResponse = { status: 200, headers: {}, body: '', delayMs: 0 },
  ): Promise<SandboxReplayResult> {
    const deadLetter = await prisma.deadLetter.findFirst({
      where: { id, userId },
      select: { id: true, payload: true, error: true, channel: true, destination: true },
    });

    if (!deadLetter) {
      throw new Error('Dead letter not found');
    }

    // ── 1. Resolve the signing secret the dispatch pipeline would have used ──
    // For webhook-channel dead letters the destination IS the webhook URL, so
    // the exact webhook (and therefore the exact signing secret) is restorable;
    // otherwise fall back to the user's most recent webhook.
    let signingSecret: string | null = null;
    const isWebhookChannel = deadLetter.channel === 'webhook' && !!deadLetter.destination;
    const webhook = await prisma.webhook.findFirst({
      where: isWebhookChannel ? { userId, url: deadLetter.destination! } : { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        secretCiphertext: true,
        secretIv: true,
        secretAuthTag: true,
        keyVersion: true,
      },
    });
    if (webhook) {
      try {
        const encrypted = [
          String(webhook.keyVersion),
          webhook.secretIv,
          webhook.secretAuthTag,
          webhook.secretCiphertext,
        ].join(':');
        signingSecret = cryptoVault.decrypt(encrypted);
      } catch {
        signingSecret = null;
      }
    }

    // ── 2. Build the request the receiver would have observed ───────────────
    // Unrenderable payloads still produce an inspectable marker envelope so
    // the receiver sees exactly what it would have received.
    const envelope =
      buildWebhookSandboxEnvelope(deadLetter.payload) ?? {
        event: 'deadletter.unrenderable',
        timestamp: new Date().toISOString(),
        data: { deadLetterId: deadLetter.id, error: deadLetter.error },
      };
    const body = JSON.stringify(envelope);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'StellarAlerts-Sandbox/1.0',
      'X-Stellar-Sandbox-DeadLetter-Id': deadLetter.id,
    };
    if (signingSecret) {
      // Sandbox-scoped key manager (the Map-based KeyRotationManager used by
      // webhooks.service.ts) so real webhook key state on the live dispatch
      // path is never mutated or observed by replays.
      const keyManager = new KeyRotationManager();
      keyManager.setKeyState(SANDBOX_KEY_ID, { activeSecret: signingSecret });
      const signed = keyManager.sign(body, SANDBOX_KEY_ID);
      headers['X-Stellar-Signature'] = signed.primary.headerValue;
      if (signed.secondary) {
        headers['X-Stellar-Signature-Secondary'] = signed.secondary.headerValue;
      }
    } else {
      // No verifiable secret available; still deliver an inspectable request
      // so developers can see exactly what their receiver must parse.
      headers['X-Stellar-Signature'] = 't=0,v1=unsigned-sandbox-replay';
    }

    const observation: SandboxRequestObservation = { envelope, body, headers };

    // ── 3. Sandbox receiver: apply the mock response ────────────────────────
    const startedAt = Date.now();
    let response: SandboxResponseObservation;
    let status: 'completed' | 'failed' = 'completed';
    let error: string | null = null;

    try {
      if (mock.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
      }
      response = {
        status: mock.status,
        headers: { ...mock.headers, 'X-Stellar-Sandbox': 'mock-response' },
        body: mock.body,
        delayMs: mock.delayMs,
      };
    } catch (err: any) {
      status = 'failed';
      error = err?.message ?? 'Sandbox receiver error';
      response = { status: 0, headers: {}, body: '', delayMs: mock.delayMs };
    }
    const durationMs = Date.now() - startedAt;

    // ── 4. Persist the full inspection record ───────────────────────────────
    const stored = await prisma.webhookSandboxReplay.create({
      data: {
        deadLetterId: deadLetter.id,
        userId,
        replayType: SANDBOX_REPLAY_TYPE,
        requestEnvelope: observation.envelope as any,
        requestHeaders: observation.headers as any,
        requestBody: observation.body,
        responseStatus: response.status,
        responseHeaders: response.headers as any,
        responseBody: response.body,
        responseDelayMs: response.delayMs,
        durationMs,
        status,
        error,
      },
    });

    return {
      success: status === 'completed' && response.status >= 200 && response.status < 300,
      replay: {
        id: stored.id,
        status,
        request: observation,
        response,
        durationMs,
        error,
        createdAt: stored.createdAt,
      },
    };
  }

  /**
   * Lists the caller's sandbox replay inspections, newest first.
   */
  async listReplays(
    userId: string,
    params: { status?: 'completed' | 'failed'; page: number; pageSize: number } = {
      page: 1,
      pageSize: 20,
    },
  ) {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const where: Record<string, any> = { userId };
    if (params.status) {
      where.status = params.status;
    }

    const [items, total] = await Promise.all([
      prisma.webhookSandboxReplay.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.webhookSandboxReplay.count({ where }),
    ]);

    return {
      items,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /**
   * Returns one sandbox replay inspection owned by the caller.
   */
  async getReplay(id: string, userId: string) {
    const replay = await prisma.webhookSandboxReplay.findFirst({
      where: { id, userId },
    });
    if (!replay) {
      throw new Error('Sandbox replay not found');
    }
    return replay;
  }
}

export const webhookSandboxService = new WebhookSandboxService();
