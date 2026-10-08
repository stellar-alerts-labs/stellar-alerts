import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webhookSandboxService } from '../webhook-sandbox.service';
import {
  sandboxReplayInputSchema,
  sandboxMockResponseSchema,
  listSandboxReplaysQuerySchema,
} from '../dead-letters.schema';

const mockPrisma = vi.hoisted(() => ({
  deadLetter: {
    findFirst: vi.fn(),
  },
  webhook: {
    findFirst: vi.fn(),
  },
  webhookSandboxReplay: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: mockPrisma,
}));

const mockCryptoVault = vi.hoisted(() => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('../../../utils/crypto-vault', () => ({
  cryptoVault: mockCryptoVault,
}));

const userA = 'user-a';
const userB = 'user-b';

/** Full receiver envelope as persisted on webhook-channel dead letters. */
const sandboxWebhookEnvelope = {
  event: 'payment.received',
  timestamp: '2026-01-01T00:00:00.000Z',
  data: {
    paymentId: 'pay-2',
    txHash: 'tx-2',
    amount: '42.00',
    asset: 'USDC',
    assetIssuer: 'GISSUER',
    fromAddress: 'GFROM',
    receivedAt: '2026-01-01T00:00:00.000Z',
  },
};

const webhookDeadLetterRow = {
  id: 'dl-2',
  payload: sandboxWebhookEnvelope,
  error: 'Webhook endpoint refused connection',
  channel: 'webhook',
  destination: 'https://specific-receiver.example.com/hook',
  status: 'pending',
};

const queueDeadLetter = {
  id: 'dl-1',
  payload: {
    paymentId: 'pay-1',
    txHash: 'tx-1',
    walletId: 'wallet-1',
    amount: '125.50',
    asset: 'XLM',
    assetIssuer: null,
    fromAddress: 'GABC',
    receivedAt: '2026-01-01T00:00:00.000Z',
  },
  error: 'Webhook endpoint responded with 500',
  channel: 'webhook',
  destination: 'https://receiver.example.com/hook',
  status: 'pending',
};

const webhookDeadLetter = {
  ...webhookDeadLetterRow,
};

describe('WebhookSandboxService (#456)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.deadLetter.findFirst.mockResolvedValue({ ...queueDeadLetter });
    mockPrisma.webhook.findFirst.mockResolvedValue({
      id: 'wh-1',
      secretCiphertext: 'ct',
      secretIv: 'iv',
      secretAuthTag: 'tag',
      keyVersion: 1,
    });
    mockCryptoVault.decrypt.mockReturnValue('sandbox-signing-secret');
    mockPrisma.webhookSandboxReplay.create.mockImplementation(async ({ data }) => ({
      id: 'sr-1',
      createdAt: new Date(),
      ...data,
    }));
    mockPrisma.webhookSandboxReplay.findMany.mockResolvedValue([]);
    mockPrisma.webhookSandboxReplay.count.mockResolvedValue(0);
    mockPrisma.webhookSandboxReplay.findFirst.mockResolvedValue(null);
  });

  it('captures the full request the receiver would observe and the mock response', async () => {
    const result = await webhookSandboxService.replaySandbox('dl-1', userA, {
      status: 202,
      headers: { 'X-Trace': 'abc' },
      body: '{"accepted":true}',
      delayMs: 0,
    });

    // Request side
    expect(result.replay.request.body).toContain('payment.received');
    expect(result.replay.request.body).toContain('pay-1');
    expect(result.replay.request.headers['Content-Type']).toBe('application/json');
    expect(result.replay.request.headers['X-Stellar-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(result.replay.request.headers['X-Stellar-Sandbox-DeadLetter-Id']).toBe('dl-1');

    // Response side
    expect(result.replay.response.status).toBe(202);
    expect(result.replay.response.headers['X-Trace']).toBe('abc');
    expect(result.replay.response.headers['X-Stellar-Sandbox']).toBe('mock-response');
    expect(result.replay.response.body).toBe('{"accepted":true}');

    // Success verdict follows the mock status
    expect(result.success).toBe(true);
  });

  it('rebuilds the canonical payment.received envelope for queue-channel dead letters', async () => {
    const result = await webhookSandboxService.replaySandbox('dl-1', userA);

    expect(result.replay.request.envelope).toMatchObject({
      event: 'payment.received',
      data: {
        paymentId: 'pay-1',
        txHash: 'tx-1',
        amount: '125.50',
        asset: 'XLM',
        fromAddress: 'GABC',
      },
    });
  });

  it('returns webhook-channel envelopes verbatim', async () => {
    mockPrisma.deadLetter.findFirst.mockResolvedValue({ ...webhookDeadLetter });

    const result = await webhookSandboxService.replaySandbox('dl-2', userA);

    expect(result.replay.request.envelope).toEqual(sandboxWebhookEnvelope);
  });

  it('falls back to an unrenderable marker envelope when the payload cannot be converted', async () => {
    mockPrisma.deadLetter.findFirst.mockResolvedValue({
      ...queueDeadLetter,
      payload: { broken: true },
    });

    const result = await webhookSandboxService.replaySandbox('dl-1', userA);

    expect(result.replay.request.envelope).toMatchObject({
      event: 'deadletter.unrenderable',
      data: { deadLetterId: 'dl-1' },
    });
    // The replay still completes and is inspectable.
    expect(result.replay.response.status).toBe(200);
  });

  it('uses the exact webhook secret for webhook-channel dead letters', async () => {
    mockPrisma.deadLetter.findFirst.mockResolvedValue({ ...webhookDeadLetter });

    await webhookSandboxService.replaySandbox('dl-2', userA);

    expect(mockPrisma.webhook.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: userA, url: webhookDeadLetter.destination }),
      }),
    );
  });

  it('falls back to the most recent webhook when the dead letter is not webhook-channel', async () => {
    mockPrisma.deadLetter.findFirst.mockResolvedValue({
      ...queueDeadLetter,
      channel: 'telegram',
      destination: 'chat-1',
    });

    await webhookSandboxService.replaySandbox('dl-1', userA);

    expect(mockPrisma.webhook.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: userA },
      }),
    );
  });

  it('marks the replay failed when the mock returns a 5xx', async () => {
    const result = await webhookSandboxService.replaySandbox('dl-1', userA, {
      status: 503,
      headers: {},
      body: 'unavailable',
      delayMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.replay.response.status).toBe(503);
  });

  it('rejects access to another users dead letter', async () => {
    mockPrisma.deadLetter.findFirst.mockResolvedValue(null);

    await expect(webhookSandboxService.replaySandbox('dl-1', userB)).rejects.toThrow('Dead letter not found');
    expect(mockPrisma.webhookSandboxReplay.create).not.toHaveBeenCalled();
  });

  it('measures wall-clock duration including the mock delay', async () => {
    const result = await webhookSandboxService.replaySandbox('dl-1', userA, {
      status: 200,
      headers: {},
      body: '',
      delayMs: 25,
    });

    expect(result.replay.response.delayMs).toBe(25);
    expect(result.replay.durationMs).toBeGreaterThanOrEqual(20);
  });

  it('persists the full inspection record', async () => {
    await webhookSandboxService.replaySandbox('dl-1', userA, {
      status: 404,
      headers: { 'X-Mock': '1' },
      body: 'nope',
      delayMs: 0,
    });

    expect(mockPrisma.webhookSandboxReplay.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deadLetterId: 'dl-1',
        userId: userA,
        replayType: 'sandbox-replay',
        responseStatus: 404,
        responseBody: 'nope',
        status: 'completed',
      }),
    });
  });

  it('lists only the caller-owned sandbox replays with pagination', async () => {
    mockPrisma.webhookSandboxReplay.findMany.mockResolvedValue([{ id: 'sr-1' }]);
    mockPrisma.webhookSandboxReplay.count.mockResolvedValue(1);

    const result = await webhookSandboxService.listReplays(userA, { status: 'failed', page: 2, pageSize: 10 });

    expect(mockPrisma.webhookSandboxReplay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: userA, status: 'failed' },
        skip: 10,
        take: 10,
      }),
    );
    expect(result.pagination).toEqual({ page: 2, pageSize: 10, total: 1, totalPages: 1 });
  });

  it('gets one sandbox replay for its owner and rejects others', async () => {
    mockPrisma.webhookSandboxReplay.findFirst.mockResolvedValue({ id: 'sr-1', userId: userA });
    const replay = await webhookSandboxService.getReplay('sr-1', userA);
    expect(replay.id).toBe('sr-1');

    mockPrisma.webhookSandboxReplay.findFirst.mockResolvedValue(null);
    await expect(webhookSandboxService.getReplay('sr-1', userB)).rejects.toThrow('Sandbox replay not found');
  });
});

describe('sandbox schemas (#456)', () => {
  it('applies documented defaults to the mock response', () => {
    const parsed = sandboxReplayInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.mockStatusCode).toBe(200);
      expect(parsed.data.mockResponseBody).toBeUndefined();
      expect(parsed.data.mockResponseHeaders).toBeUndefined();
    }
  });

  it('rejects out-of-range mock statuses', () => {
    expect(sandboxReplayInputSchema.safeParse({ mockStatusCode: 99 }).success).toBe(false);
    expect(sandboxReplayInputSchema.safeParse({ mockStatusCode: 600 }).success).toBe(false);
  });

  it('validates pagination bounds on the replay list query', () => {
    expect(listSandboxReplaysQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listSandboxReplaysQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
