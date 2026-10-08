/**
 * Notifications Controller
 * 
 * Handles HTTP requests for notification preferences, freelancer setup flow,
 * and Telegram account linking with one-time sync codes.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { notificationsService } from './notifications.service';
import { telegramSyncService } from './telegram-sync.service';
import { AuthenticationError, AuthorizationError, ProviderError, ValidationError } from '../../lib/errors';

export class NotificationsController {
  /**
   * Update notification preferences (MFA protected).
   */
  async updatePreferences(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const body = (request.body as any) || {};
    const { mfaToken, ...preferences } = body;

    try {
      await notificationsService.updatePreferences(
        request.user.id,
        preferences,
        mfaToken
      );

      return reply.send({
        success: true,
        message: 'Notification preferences updated successfully',
      });
    } catch (error: any) {
      if (error.message === 'MFA token required') {
        throw new AuthorizationError(
          'Multi-factor authentication is enabled. Please provide a valid TOTP token.',
          'MFA_TOKEN_REQUIRED',
        );
      }

      if (error.message === 'Invalid MFA token') {
        throw new AuthorizationError('The provided TOTP token is invalid or expired.', 'INVALID_MFA_TOKEN');
      }

      if (
        error.message.startsWith('Invalid WhatsApp number') ||
        error.message.startsWith('A valid WhatsApp number is required')
      ) {
        throw new ValidationError(error.message, undefined, 'INVALID_WHATSAPP_PREFERENCES');
      }

      throw error;
    }
  }

  /**
   * Get notification preferences for the authenticated user.
   */
  async getPreferences(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const preferences = await notificationsService.getPreferences(request.user.id);
    return reply.send({
      success: true,
      preferences: preferences || {},
    });
  }

  /**
   * Update freelancer channel setup preferences (#259).
   */
  async updateFreelancerPreferences(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const body = (request.body as any) || {};
    const { mfaToken, ...preferences } = body;

    await notificationsService.updatePreferences(
      request.user.id,
      preferences,
      mfaToken
    );

    const updated = await notificationsService.getPreferences(request.user.id);

    return reply.send({
      success: true,
      message: 'Freelancer notification preferences configured successfully',
      preferences: updated,
    });
  }

  /**
   * Get freelancer channel setup preferences (#259).
   */
  async getFreelancerPreferences(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const preferences = await notificationsService.getPreferences(request.user.id);
    return reply.send({
      success: true,
      preferences: preferences || {},
    });
  }

  /**
   * Generate an expiring one-time sync code for Telegram account linking (#260).
   */
  async generateTelegramSyncCode(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const body = (request.body as { walletAddress?: string }) || {};
    const result = await telegramSyncService.generateSyncCode(request.user.id, body.walletAddress);

    return reply.send({
      success: true,
      ...result,
    });
  }

  /**
   * Confirm Telegram linking via a one-time sync code (#260).
   * Verifies expiry and applies replay protection.
   */
  async confirmTelegramSync(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as { code: string; telegramChatId: string };
    if (!body?.code || !body?.telegramChatId) {
      throw new ValidationError('code and telegramChatId are required');
    }

    const result = await telegramSyncService.confirmSync(body.code, body.telegramChatId);
    return reply.send(result);
  }

  /**
   * Get confirmation status of a Telegram sync code (#260).
   */
  async getTelegramSyncStatus(request: FastifyRequest, reply: FastifyReply) {
    const params = request.params as { code: string };
    if (!params?.code) {
      throw new ValidationError('Sync code parameter is required');
    }

    const result = await telegramSyncService.getSyncStatus(params.code);
    return reply.send({
      success: true,
      ...result,
    });
  }

  /**
   * Unlink a user's Telegram account (#260).
   */
  async unlinkTelegram(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const result = await telegramSyncService.unlinkTelegram(request.user.id);
    return reply.send(result);
  }

  /**
   * Send a one-off test ping on a configured channel (used by the
   * onboarding wizard to verify a link before activation).
   */
  async sendTestPing(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const body = request.body as { channel?: 'telegram' | 'push' };
    const channel = body?.channel;

    if (channel !== 'telegram' && channel !== 'push') {
      throw new ValidationError('channel must be "telegram"', undefined, 'INVALID_CHANNEL');
    }

    try {
      const result = await notificationsService.sendTestPing(request.user.id, channel);
      if (!result.success) {
        throw new ProviderError(result.message, 'TEST_PING_PROVIDER_FAILURE');
      }
      return reply.send({ success: true, message: result.message });
    } catch (error: any) {
      if (error instanceof ProviderError) throw error;
      throw new ValidationError(error.message, undefined, 'TEST_PING_FAILED');
    }
  }
}

export const notificationsController = new NotificationsController();
