import { prisma } from '../../lib/prisma';
import { buildDeliveryKey } from '../../lib/delivery';
import { processAlertDispatch, type AlertJobData } from '../../lib/queue';
import { CursorError } from '../../utils/pagination';

export interface DeadLetterListParams {
  channel?: string;
  status?: 'pending' | 'retried' | 'suppressed';
  q?: string;
  maxAgeDays?: number;
  /** Opaque cursor from a previous page's `pagination.nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface ReplayResult {
  success: boolean;
  message: string;
}

export class DeadLettersService {
  async list(userId: string, params: DeadLetterListParams = {}) {
    const limit = params.limit ?? 20;
    const where: Record<string, any> = { userId };

    if (params.channel) {
      where.channel = params.channel;
    }
    if (params.status) {
      where.status = params.status;
    }
    if (params.maxAgeDays) {
      const since = new Date(Date.now() - params.maxAgeDays * 24 * 60 * 60 * 1000);
      where.failedAt = { gte: since };
    }
    if (params.q) {
      where.OR = [
        { error: { contains: params.q, mode: 'insensitive' } },
        { destination: { contains: params.q, mode: 'insensitive' } },
      ];
    }

    // Cursor condition — dead-letters are ordered by failedAt DESC, id DESC.
    // The cursor encodes { failedAt, id } of the last row on the previous page.
    if (params.cursor) {
      const { failedAt, id } = decodeDeadLetterCursor(params.cursor);
      const cursorCondition = {
        OR: [
          { failedAt: { lt: failedAt } },
          { failedAt, id: { lt: id } },
        ],
      };
      // Merge with any existing failedAt age filter
      if (where.failedAt) {
        where.AND = [{ failedAt: where.failedAt }, cursorCondition];
        delete where.failedAt;
      } else {
        Object.assign(where, cursorCondition);
      }
    }

    const rows = await prisma.deadLetter.findMany({
      where,
      orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        deliveryKey: true,
        paymentId: true,
        channel: true,
        destination: true,
        error: true,
        status: true,
        retryCount: true,
        failedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const hasNextPage = rows.length > limit;
    const items = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasNextPage && items.length > 0
        ? encodeDeadLetterCursor(items[items.length - 1])
        : undefined;

    return {
      items,
      pagination: { limit, nextCursor, hasNextPage },
    };
  }

  async get(id: string, userId: string) {
    const deadLetter = await prisma.deadLetter.findFirst({
      where: { id, userId },
      include: {
        auditLogs: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!deadLetter) {
      throw new Error('Dead letter not found');
    }
    return deadLetter;
  }

  /**
   * Replays a dead letter through the real dispatch pipeline. Delivered
   * channels are skipped by the idempotency gate and concurrent replays of the
   * same dead letter collapse to a single provider request (#272), so replay
   * never double-sends.
   */
  async replay(id: string, userId: string): Promise<ReplayResult> {
    const deadLetter = await this.get(id, userId);

    if (deadLetter.status === 'suppressed') {
      throw new Error('Suppressed dead letters cannot be replayed');
    }

    const data = toAlertJobData(deadLetter.payload);
    if (!data) {
      throw new Error('Dead letter has no replayable payload');
    }

    await processAlertDispatch(data);

    const delivered = await this.deliverySucceeded(deadLetter);

    await prisma.deadLetter.update({
      where: { id: deadLetter.id },
      data: {
        retryCount: { increment: 1 },
        status: delivered ? 'retried' : 'pending',
      },
    });

    await prisma.deadLetterAudit.create({
      data: {
        deadLetterId: deadLetter.id,
        actorUserId: userId,
        action: delivered ? 'retry' : 'retry_failed',
        note: delivered
          ? 'Replayed through dispatch pipeline; provider acknowledged delivery'
          : 'Replay completed but no delivered attempt was recorded',
      },
    });

    return {
      success: delivered,
      message: delivered
        ? 'Replayed; provider acknowledged the delivery'
        : 'Replay completed but delivery did not reach the provider',
    };
  }

  async suppress(id: string, userId: string, note?: string) {
    const deadLetter = await this.get(id, userId);

    if (deadLetter.status === 'suppressed') {
      throw new Error('Dead letter is already suppressed');
    }

    const [updated] = await prisma.$transaction([
      prisma.deadLetter.update({
        where: { id: deadLetter.id },
        data: { status: 'suppressed' },
      }),
      prisma.deadLetterAudit.create({
        data: {
          deadLetterId: deadLetter.id,
          actorUserId: userId,
          action: 'suppress',
          note: note ?? 'Suppressed by operator',
        },
      }),
    ]);

    return updated;
  }

  private async deliverySucceeded(deadLetter: {
    deliveryKey: string | null;
    paymentId: string | null;
    channel: string;
    destination: string | null;
  }): Promise<boolean> {
    const deliveryKey =
      deadLetter.paymentId && deadLetter.destination
        ? buildDeliveryKey(deadLetter.paymentId, deadLetter.channel, deadLetter.destination)
        : deadLetter.deliveryKey;

    if (!deliveryKey) return false;

    const attempt = await prisma.notificationDeliveryAttempt.findFirst({
      where: { deliveryKey, status: 'delivered' },
      select: { id: true },
    });
    return attempt !== null;
  }
}

export const deadLettersService = new DeadLettersService();

// ---------------------------------------------------------------------------
// Dead-letter cursor helpers
// Dead-letters use `failedAt` (not `createdAt`) as the primary sort key.
// ---------------------------------------------------------------------------

interface DeadLetterCursorPayload {
  failedAt: string;
  id: string;
}

/**
 * Encodes the last dead-letter on a page into an opaque base64url cursor.
 */
export function encodeDeadLetterCursor(item: { id: string; failedAt: Date }): string {
  const payload: DeadLetterCursorPayload = {
    failedAt: item.failedAt.toISOString(),
    id: item.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes an opaque dead-letter cursor.
 * Throws {@link CursorError} if the cursor is malformed.
 */
export function decodeDeadLetterCursor(cursor: string): { failedAt: Date; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new CursorError();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new CursorError();
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as any).failedAt !== 'string' ||
    typeof (payload as any).id !== 'string' ||
    isNaN(Date.parse((payload as any).failedAt))
  ) {
    throw new CursorError();
  }

  return {
    failedAt: new Date((payload as DeadLetterCursorPayload).failedAt),
    id: (payload as DeadLetterCursorPayload).id,
  };
}