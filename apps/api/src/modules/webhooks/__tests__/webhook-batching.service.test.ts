import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookBatchingService, webhookBatchingService, MicroPaymentEvent } from '../webhook-batching.service';

describe('WebhookBatchingService', () => {
  let svc: WebhookBatchingService;

  beforeEach(() => {
    vi.useFakeTimers();
    svc = new WebhookBatchingService(500);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches events within the time window and emits flush', async () => {
    const emitted: any[] = [];
    svc.on('flush', (payload) => emitted.push(payload));

    const evt1: MicroPaymentEvent = { accountId: 'A1', amount: 1, asset: 'XLM', txHash: 't1' };
    const evt2: MicroPaymentEvent = { accountId: 'A1', amount: 2, asset: 'XLM', txHash: 't2' };

    svc.addEvent(evt1);
    svc.addEvent(evt2);

    // advance time just before flush
    vi.advanceTimersByTime(499);
    expect(emitted.length).toBe(0);

    // trigger flush
    vi.advanceTimersByTime(2);
    expect(emitted.length).toBe(1);
    const payload = emitted[0];
    expect(payload.accountId).toBe('A1');
    expect(payload.count).toBe(2);
    expect(payload.totalAmount).toBe(3);
  });

  it('separates different assets or accounts into different windows', () => {
    const emitted: any[] = [];
    svc.on('flush', (p) => emitted.push(p));

    svc.addEvent({ accountId: 'A1', amount: 1, asset: 'XLM' });
    svc.addEvent({ accountId: 'A2', amount: 5, asset: 'XLM' });
    svc.addEvent({ accountId: 'A1', amount: 10, asset: 'USDC' });

    vi.advanceTimersByTime(501);
    expect(emitted.length).toBe(3);
    const keys = emitted.map((p) => `${p.accountId}:${p.asset}`).sort();
    expect(keys).toEqual(['A1:USDC', 'A1:XLM', 'A2:XLM']);
  });
});
