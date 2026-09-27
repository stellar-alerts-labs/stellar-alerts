/**
 * Notifications Controller
 * 
 * Handles HTTP requests for notification preferences.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { notificationsService } from './notifications.service';
import { buildAlertConfigurationList, buildAlertQuickActions, buildConfigurationConfirmation, parseWhatsAppInteractiveReply, sendWhatsAppInteractiveMessage } from '../../utils/whatsapp-interactive';

export class NotificationsController {
  /**
   * Update notification preferences
   */
  async updatePreferences(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as any;
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
        return reply.status(403).send({
          error: 'MFA token required',
          message: 'Multi-factor authentication is enabled. Please provide a valid TOTP token.',
        });
      }

      if (error.message === 'Invalid MFA token') {
        return reply.status(403).send({
          error: 'Invalid MFA token',
          message: 'The provided TOTP token is invalid or expired.',
        });
      }

      if (
        error.message.startsWith('Invalid WhatsApp number') ||
        error.message.startsWith('A valid WhatsApp number is required')
      ) {
        return reply.status(400).send({
          error: 'Invalid WhatsApp preferences',
          message: error.message,
        });
      }

      return reply.status(500).send({
        error: 'Failed to update preferences',
        message: error.message,
      });
    }
  }

  /**
   * Get notification preferences
   */
  async getPreferences(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    try {
      const preferences = await notificationsService.getPreferences(request.user.id);
      return reply.send({
        success: true,
        preferences: preferences || {},
      });
    } catch (error: any) {
      return reply.status(500).send({
        error: 'Failed to get preferences',
        message: error.message,
      });
    }
  }

  /**
   * Send a one-off test ping on a configured channel (used by the
   * onboarding wizard to verify a link before activation).
   */
  async sendTestPing(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as { channel?: string };
    const channel = body?.channel;

    if (channel !== 'telegram') {
      return reply.status(400).send({
        error: 'Invalid channel',
        message: 'channel must be "telegram"',
      });
    }

    try {
      const result = await notificationsService.sendTestPing(request.user.id, channel);
      return reply.status(result.success ? 200 : 502).send({
        success: result.success,
        message: result.message,
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: 'Failed to send test ping',
        message: error.message,
      });
    }
  }

  async whatsappWebhookVerification(request: FastifyRequest, reply: FastifyReply) {
    const query = request.query as { 'hub.mode'?: string; 'hub.verify_token'?: string; 'hub.challenge'?: string };
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return reply.type('text/plain').send(query['hub.challenge']);
    }
    return reply.status(403).send({ error: 'Webhook verification failed' });
  }

  async whatsappWebhook(request: FastifyRequest, reply: FastifyReply) {
    const parsed = parseWhatsAppInteractiveReply(request.body);
    if (!parsed?.replyId) return reply.send({ received: true });
    if (!process.env.WHATSAPP_CLOUD_API_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
      return reply.status(503).send({ error: 'WhatsApp Cloud API is not configured' });
    }

    try {
      const result = await notificationsService.applyWhatsAppAction(parsed.from, parsed.replyId);
      const to = parsed.from.startsWith('+') ? parsed.from : `+${parsed.from}`;
      const message = result.kind === 'configure'
        ? buildAlertConfigurationList(to)
        : result.kind === 'updated'
          ? buildConfigurationConfirmation(to, result.amount!)
          : buildAlertQuickActions(to, result.kind === 'enabled');
      await sendWhatsAppInteractiveMessage(to, message, {
        accessToken: process.env.WHATSAPP_CLOUD_API_TOKEN,
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        apiVersion: process.env.WHATSAPP_CLOUD_API_VERSION,
      });
    } catch (error: any) {
      request.log.warn({ err: error }, 'WhatsApp interactive message could not be applied');
    }
    return reply.send({ received: true });
  }
}

export const notificationsController = new NotificationsController();
