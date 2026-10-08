import { EventEmitter } from 'events';

export interface MicroPaymentEvent {
  accountId: string;
  amount: number;
  asset: string;
  txHash?: string;
  receivedAt?: string;
}

export interface AggregatedWebhookPayload {
  accountId: string;
  totalAmount: number;
  asset: string;
  count: number;
  events: MicroPaymentEvent[];
  windowStart: string;
  windowEnd: string;
}

/**
 * In-memory batching engine for high-frequency micro-payments.
 * - Collects events per account+asset key
 * - Emits an `flush` event with AggregatedWebhookPayload when window expires
 * NOTE: This is intentionally lightweight and in-memory for unit tests and
 * as a pluggable starting point. Production should back with Redis/BullMQ.
 */
export class WebhookBatchingService extends EventEmitter {
  private windows = new Map<string, {
    events: MicroPaymentEvent[];
    total: number;
    timer?: NodeJS.Timeout;
    start: number;
  }>();

  constructor(private windowMs: number = 1000) {
    super();
  }

  private keyFor(evt: MicroPaymentEvent) {
    return `${evt.accountId}::${evt.asset}`;
  }

  public addEvent(evt: MicroPaymentEvent) {
    const key = this.keyFor(evt);
    const now = Date.now();
    let slot = this.windows.get(key);
    if (!slot) {
      slot = { events: [], total: 0, start: now };
      this.windows.set(key, slot);
      slot.timer = setTimeout(() => this.flushKey(key), this.windowMs);
    }

    slot.events.push({ ...evt, receivedAt: new Date().toISOString() });
    slot.total += evt.amount;
  }

  public flushKey(key: string) {
    const slot = this.windows.get(key);
    if (!slot) return;
    if (slot.timer) clearTimeout(slot.timer);

    const [accountId, asset] = key.split('::');
    const payload: AggregatedWebhookPayload = {
      accountId,
      asset,
      totalAmount: slot.total,
      count: slot.events.length,
      events: slot.events.slice(),
      windowStart: new Date(slot.start).toISOString(),
      windowEnd: new Date().toISOString(),
    };

    this.windows.delete(key);
    this.emit('flush', payload);
  }

  public flushAll() {
    for (const key of Array.from(this.windows.keys())) {
      this.flushKey(key);
    }
  }

  public size() {
    return this.windows.size;
  }
}

export const webhookBatchingService = new WebhookBatchingService(1000);
