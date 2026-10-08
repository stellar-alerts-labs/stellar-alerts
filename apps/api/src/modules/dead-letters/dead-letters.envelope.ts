import type { AlertJobData } from '../../lib/queue';

/**
 * Extracts the canonical `AlertJobData` that processAlertDispatch needs from a
 * dead letter's stored payload. Queue-channel dead letters persist the raw job
 * data; channel dead letters (telegram/email/webhook) persist the webhook
 * payload envelope with the payment fields under `data`.
 */
export function toAlertJobData(payload: unknown): AlertJobData | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, any>;

  const candidate = value.walletId && value.txHash ? value : value.data ?? null;
  if (!candidate || typeof candidate !== 'object') return null;

  if (typeof candidate.paymentId !== 'string') return null;
  return {
    paymentId: candidate.paymentId,
    txHash: candidate.txHash ?? 'unknown',
    walletId: candidate.walletId ?? '',
    amount: typeof candidate.amount === 'string' ? candidate.amount : String(candidate.amount ?? '0'),
    asset: candidate.asset ?? 'XLM',
    assetIssuer: candidate.assetIssuer ?? null,
    fromAddress: candidate.fromAddress ?? '',
    receivedAt: candidate.receivedAt ?? new Date().toISOString(),
    requestId: undefined,
  };
}

/**
 * Reconstructs the exact webhook payload envelope a receiver would have
 * observed for a dead letter.
 *
 * - Webhook-channel dead letters already persist the full receiver envelope
 *   (`{ event, timestamp, data }`) — returned verbatim.
 * - Queue-channel dead letters persist raw `AlertJobData`; the canonical
 *   `payment.received` envelope is rebuilt from it (mirroring the shape the
 *   dispatch pipeline constructs in `lib/queue.ts`).
 *
 * Returns `null` when the payload cannot be turned into a webhook envelope.
 */
export function buildWebhookSandboxEnvelope(
  payload: unknown,
  fallbackTimestamp: Date = new Date(),
): Record<string, unknown> | null {
  const data = toAlertJobData(payload);
  if (!data) return null;

  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, any>;
    if (
      typeof value.event === 'string' &&
      value.data &&
      typeof value.data === 'object' &&
      typeof value.data.paymentId === 'string'
    ) {
      return value;
    }
  }

  return {
    event: 'payment.received',
    timestamp: fallbackTimestamp.toISOString(),
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
}
