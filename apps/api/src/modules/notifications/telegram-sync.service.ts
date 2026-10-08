import crypto from 'crypto';
import QRCode from 'qrcode';
import { prisma } from '../../lib/prisma';
import { encryptPersonalField } from '../../utils/privacy';
import { ValidationError, NotFoundError } from '../../lib/errors';

export interface TelegramSyncCodeResult {
  code: string;
  expiresAt: string;
  deepLink: string;
  qrCodeDataUrl: string;
}

export interface TelegramSyncStatusResult {
  code: string;
  isUsed: boolean;
  isExpired: boolean;
  isConfirmed: boolean;
  confirmedAt?: string | null;
}

export class TelegramSyncService {
  /**
   * Generates an expiring one-time sync code for wallet-to-Telegram linking (#260).
   * Generates a deep link and QR code without exposing bot secrets.
   */
  async generateSyncCode(userId: string, walletAddress?: string): Promise<TelegramSyncCodeResult> {
    // Generate secure 8-character uppercase alphanumeric code
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes TTL

    // Invalidate any existing unused codes for this user
    await (prisma as any).telegramSyncCode.updateMany({
      where: { userId, isUsed: false },
      data: { isUsed: true },
    });

    await (prisma as any).telegramSyncCode.create({
      data: {
        userId,
        walletAddress: walletAddress ?? null,
        code,
        expiresAt,
        isUsed: false,
      },
    });

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'StellarAlertsBot';
    const deepLink = `https://t.me/${botUsername}?start=sync_${code}`;

    let qrCodeDataUrl = '';
    try {
      qrCodeDataUrl = await QRCode.toDataURL(deepLink, { width: 280, margin: 2 });
    } catch {
      qrCodeDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(deepLink)}`;
    }

    return {
      code,
      expiresAt: expiresAt.toISOString(),
      deepLink,
      qrCodeDataUrl,
    };
  }

  /**
   * Confirms Telegram linking via a one-time sync code.
   * Enforces replay protection and expiration check.
   */
  async confirmSync(code: string, telegramChatId: string): Promise<{
    success: boolean;
    confirmed: boolean;
    userId: string;
    linkedAt: string;
  }> {
    if (!code || typeof code !== 'string') {
      throw new ValidationError('Sync code is required', undefined, 'MISSING_SYNC_CODE');
    }
    if (!telegramChatId || typeof telegramChatId !== 'string') {
      throw new ValidationError('Telegram chat ID is required', undefined, 'MISSING_CHAT_ID');
    }

    const normalizedCode = code.trim().toUpperCase();

    const record = await (prisma as any).telegramSyncCode.findUnique({
      where: { code: normalizedCode },
    });

    if (!record) {
      throw new NotFoundError('Invalid sync code', 'INVALID_SYNC_CODE');
    }

    // Replay protection
    if (record.isUsed) {
      throw new ValidationError('Sync code has already been used', undefined, 'SYNC_CODE_ALREADY_USED');
    }

    // Expiry check
    if (new Date() > record.expiresAt) {
      throw new ValidationError('Sync code has expired', undefined, 'SYNC_CODE_EXPIRED');
    }

    const now = new Date();

    // Mark sync code as used
    await (prisma as any).telegramSyncCode.update({
      where: { id: record.id },
      data: {
        isUsed: true,
        chatId: telegramChatId,
        confirmedAt: now,
      },
    });

    // Link Telegram to user's notification preferences with encrypted PII
    const encryptedChatId = encryptPersonalField(telegramChatId);
    await (prisma as any).notificationPreference.upsert({
      where: { userId: record.userId },
      create: {
        userId: record.userId,
        telegramChatId: encryptedChatId,
        telegramEnabled: true,
      },
      update: {
        telegramChatId: encryptedChatId,
        telegramEnabled: true,
      },
    });

    return {
      success: true,
      confirmed: true,
      userId: record.userId,
      linkedAt: now.toISOString(),
    };
  }

  /**
   * Retrieves the confirmation status of a sync code without exposing bot secrets.
   */
  async getSyncStatus(code: string): Promise<TelegramSyncStatusResult> {
    if (!code || typeof code !== 'string') {
      throw new ValidationError('Sync code is required', undefined, 'MISSING_SYNC_CODE');
    }

    const record = await (prisma as any).telegramSyncCode.findUnique({
      where: { code: code.trim().toUpperCase() },
    });

    if (!record) {
      throw new NotFoundError('Invalid sync code', 'INVALID_SYNC_CODE');
    }

    const isExpired = new Date() > record.expiresAt;
    const isConfirmed = record.isUsed && Boolean(record.confirmedAt);

    return {
      code: record.code,
      isUsed: record.isUsed,
      isExpired,
      isConfirmed,
      confirmedAt: record.confirmedAt ? record.confirmedAt.toISOString() : null,
    };
  }

  /**
   * Unlinks a user's Telegram account and disables Telegram alerts.
   */
  async unlinkTelegram(userId: string): Promise<{ success: boolean; unlinked: boolean }> {
    await (prisma as any).notificationPreference.updateMany({
      where: { userId },
      data: {
        telegramChatId: null,
        telegramEnabled: false,
      },
    });

    // Invalidate any active sync codes
    await (prisma as any).telegramSyncCode.updateMany({
      where: { userId, isUsed: false },
      data: { isUsed: true },
    });

    return {
      success: true,
      unlinked: true,
    };
  }
}

export const telegramSyncService = new TelegramSyncService();
