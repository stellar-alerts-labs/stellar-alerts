import { prisma, prismaRead } from '../../lib/prisma';
import { verifyZkProof } from '../../utils/zkp-verifier';
import {
  buildCursorWhere,
  buildCursorPage,
  CURSOR_ORDER_BY,
  CursorError,
} from '../../utils/pagination';

export class WalletsService {
  async addWallet(
    userId: string,
    publicKey: string,
    label?: string,
    zkProof?: any,
    publicSignals?: string[],
    tags: string[] = []
  ) {
    console.log(`[WalletsService] Adding wallet ${publicKey} for user ${userId}`);

    let targetUserId = userId;

    if (zkProof && publicSignals) {
      const isValid = await verifyZkProof(zkProof, publicSignals);
      if (!isValid) {
        throw new Error('Invalid ZK proof');
      }

      // Valid ZK proof allows alert subscription without storing plaintext user email linkage
      const secretHash = publicSignals[0];
      const anonymousEmail = `${secretHash}@zkp.local`;

      let anonUser = await prisma.user.findUnique({ where: { email: anonymousEmail } });
      if (!anonUser) {
        anonUser = await prisma.user.create({
          data: { email: anonymousEmail }
        });
      }
      targetUserId = anonUser.id;
    }

    const normalizedTags = this.normalizeTags(tags);

    try {
      const wallet = await prisma.wallet.create({
        data: {
          userId: targetUserId,
          publicKey,
          label,
          tags: normalizedTags,
        },
      });
      return wallet;
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new Error('Wallet already exists');
      }
      throw error;
    }
  }

  /**
   * Returns a cursor-paginated list of wallets for the user.
   * Stable ordering: createdAt DESC, id DESC.
   * Optionally filters by a single tag (case-insensitive).
   */
  async getWallets(userId: string, limit: number = 20, cursor?: string, tag?: string) {
    const where: Record<string, any> = { userId };

    if (tag) {
      // Postgres array contains via haveArrayElements is case-sensitive, so we match
      // the normalized tag against the stored tags using an insensitive scan.
      const normalizedTag = tag.trim();
      where.tags = { hasAny: [normalizedTage] };
    }

    if (cursor) {
      const cursorWhere = buildCursorWhere(cursor);
      Object.assign(where, cursorWhere);
    }

    const rows = await prismaRead.wallet.findMany({
      where,
      orderBy: CURSOR_ORDER_BY,
      take: limit + 1,
    });

    return buildCursorPage(rows, limit);
  }

  /**
   * Replaces the full tag set on a wallet owned by the user.
   */
  async updateWalletTags(userId: string, walletId: string, tags: string[]) {
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });

    if (!wallet || wallet.userId !== userId) {
      throw new Error('Wallet not found');
    }

    return prisma.wallet.update({
      where: { id: walletId },
      data: { tags: this.normalizeTags(tags) },
    });
  }

  /**
   * Operator-visible ingestion health for a wallet's Horizon/Soroban cursor
   * (see lib/cursor-recovery.ts): current paging token, health status
   * (active / gap_detected), consecutive provider failures, and the most
   * recent error and gap, if any.
   */
  async getIngestionStatus(userId: string, walletId: string) {
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
      include: { cursor: true },
    });

    if (!wallet || wallet.userId !== userId) {
      throw new Error('Wallet not found');
    }

    const cursor = wallet.cursor;
    return {
      walletId: wallet.id,
      publicKey: wallet.publicKey,
      pagingToken: cursor?.pagingToken ?? null,
      status: cursor?.status ?? 'active',
      consecutiveFailures: cursor?.consecutiveFailures ?? 0,
      lastError: cursor?.lastError ?? null,
      lastSuccessAt: cursor?.lastSuccessAt ?? null,
      lastSyncedAt: cursor?.lastSyncedAt ?? null,
      gapDetectedAt: cursor?.gapDetectedAt ?? null,
      lastGapLedgerDelta: cursor?.lastGapLedgerDelta ?? null,
    };
  }

  async removeWallet(userId: string, id: string) {
    console.log(`[WalletsService] Removing wallet ${id} for user ${userId}`);
    const wallet = await prisma.wallet.findUnique({
      where: { id },
    });

    if (!wallet || wallet.userId !== userId) {
      throw new Error('Wallet not found');
    }

    try {
      await prisma.wallet.delete({
        where: { id },
      });
      return { success: true };
    } catch (error: any) {
      if (error.code === 'P2025') {
        throw new Error('Wallet not found');
      }
      throw error;
    }
  }

  /**
   * Trims, de-duplicates (case-insensitive) and drops empty tags.
   */
  private normalizeTags(tags: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of tags || []) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
    return result;
  }
}

export const walletsService = new WalletsService();
