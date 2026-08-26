import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Job } from 'bullmq';

const { queueState } = vi.hoisted(() => ({
  queueState: { failedHandler: null as any },
}));

// We mock bullmq before importing queue
vi.mock('bullmq', () => {
  const addMock = vi.fn().mockResolvedValue(true);
  
  return {
    Queue: vi.fn().mockImplementation(() => {
      return {
        add: addMock,
      };
    }),
    QueueEvents: vi.fn().mockImplementation(() => {
      return {
        on: vi.fn((event: string, handler: any) => {
          if (event === 'failed') {
            queueState.failedHandler = handler;
          }
        }),
      };
    }),
    Job: {
      fromId: vi.fn(),
    },
    Worker: vi.fn(),
  };
});

vi.mock('./prisma', () => {
  return {
    prisma: {
      wallet: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    },
  };
});

vi.mock('../utils/discord', () => {
  return {
    dispatchDiscordAlert: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('resend', () => {
  return {
    Resend: vi.fn().mockImplementation(() => {
      return {
        emails: {
          send: vi.fn().mockResolvedValue({ data: { id: 'test_id' }, error: null }),
        },
      };
    }),
  };
});

import { alertQueue, dlqQueue, alertQueueEvents, dispatchCustomWebhooks } from './queue';
import { prisma } from './prisma';

describe('Queue DLQ routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes to DLQ when job fails after max attempts', async () => {
    expect(queueState.failedHandler).toBeDefined();

    (Job.fromId as any).mockResolvedValue({
      attemptsMade: 5,
      opts: { attempts: 5 },
      data: { txHash: 'test-tx' },
    });

    await queueState.failedHandler({ jobId: '123', failedReason: 'Test error' });

    expect(dlqQueue?.add).toHaveBeenCalledWith(
      'dispatch-alert-failed',
      { txHash: 'test-tx' },
      { jobId: 'dlq-123' }
    );
  });
  
  it('does not route to DLQ if attempts < max attempts', async () => {
    expect(queueState.failedHandler).toBeDefined();

    (Job.fromId as any).mockResolvedValue({
      attemptsMade: 3,
      opts: { attempts: 5 },
      data: { txHash: 'test-tx' },
    });

    await queueState.failedHandler({ jobId: '124', failedReason: 'Test error' });

    expect(dlqQueue?.add).not.toHaveBeenCalled();
  });
});

describe('dispatchCustomWebhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches webhook with X-Stellar-Signature and X-Stellar-Alerts-Nonce headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;

    (prisma.wallet.findUnique as any).mockResolvedValue({
      id: 'wallet-1',
      user: {
        webhooks: [
          {
            id: 'wh-1',
            url: 'https://consumer.example.com/webhook',
            secret: 'secret-key-123',
            isActive: true,
          },
          {
            id: 'wh-2',
            url: 'https://discord.com/api/webhooks/123/abc',
            secret: 'secret-key-456',
            isActive: true,
          },
        ],
      },
    });

    await dispatchCustomWebhooks({
      paymentId: 'pay-123',
      txHash: 'tx-456',
      walletId: 'wallet-1',
      amount: '50.00',
      asset: 'XLM',
      fromAddress: 'GBPDX2DP...',
      receivedAt: '2026-08-26T00:00:00Z',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://consumer.example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Stellar-Signature': expect.stringMatching(/^t=\d+,n=[0-9a-f-]+,v1=[0-9a-f]+$/),
          'X-Stellar-Alerts-Nonce': expect.stringMatching(/^[0-9a-f-]+$/),
        }),
      })
    );
  });
});
