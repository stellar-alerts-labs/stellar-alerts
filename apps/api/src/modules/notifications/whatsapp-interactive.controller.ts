import { timingSafeEqual } from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '../../../generated/prisma/client';
import { prisma } from '../../lib/prisma';
import { decryptPersonalField } from '../../utils/privacy';
import {
  buildWhatsAppConfigurationList,
  buildWhatsAppQuickReplies,
  getWhatsAppPreferenceUpdate,
  sendWhatsAppInteractiveMessage,
  verifyWhatsAppWebhookSignature,
} from '../../utils/whatsapp-interactive';

interface RawBodyRequest extends FastifyRequest { rawBody?: Buffer }
type InboundMessage = { from?: string; type?: string; text?: { body?: string }; interactive?: { list_reply?: { id?: string }; button_reply?: { id?: string } } };
interface WhatsAppWebhookBody {
  entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string }; messages?: InboundMessage[] } }> }>;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class WhatsAppInteractiveController {
  async verify(request: FastifyRequest, reply: FastifyReply) {
    const query = request.query as Record<string, string>;
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';
    if (query['hub.mode'] === 'subscribe' && expected && secureEqual(query['hub.verify_token'] || '', expected)) {
      return reply.type('text/plain').send(query['hub.challenge'] || '');
    }
    return reply.status(403).send('Forbidden');
  }

  async receive(request: FastifyRequest, reply: FastifyReply) {
    const appSecret = process.env.WHATSAPP_APP_SECRET || '';
    const rawBody = (request as RawBodyRequest).rawBody;
    const signatureHeader = request.headers['x-hub-signature-256'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!appSecret || !rawBody || !verifyWhatsAppWebhookSignature(rawBody, signature, appSecret)) {
      return reply.status(401).send({ error: 'Invalid WhatsApp webhook signature' });
    }

    // Acknowledge only after signature verification; Meta retries failed webhooks.
    const body = request.body as WhatsAppWebhookBody;
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    const config = {
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    };
    if (!config.accessToken || !config.phoneNumberId) return reply.status(503).send({ error: 'WhatsApp Cloud API is not configured' });

    for (const entry of entries) {
      for (const change of entry?.changes || []) {
        const value = change?.value;
        if (value?.metadata?.phone_number_id !== config.phoneNumberId) continue;
        for (const message of (value?.messages || []) as InboundMessage[]) {
          if (!message.from) continue;
          try {
            await this.handleMessage(message, config);
          } catch (error) {
            request.log.warn({ error: error instanceof Error ? error.message : 'unknown' }, 'WhatsApp interactive message handling failed');
          }
        }
      }
    }
    return reply.send({ received: true });
  }

  private async handleMessage(message: InboundMessage, config: { accessToken: string; phoneNumberId: string }) {
    const rows = await prisma.notificationPreference.findMany({ where: { whatsappNumber: { not: null } } });
    const preference = rows.find((row) => {
      const stored = decryptPersonalField(row.whatsappNumber) || row.whatsappNumber;
      return stored?.replace(/^\+/, '') === message.from?.replace(/^\+/, '');
    });
    if (!preference || !message.from) return;

    const choice = message.interactive?.list_reply?.id || message.interactive?.button_reply?.id;
    if (!choice) {
      await sendWhatsAppInteractiveMessage(message.from, buildWhatsAppQuickReplies(), config);
      return;
    }
    if (choice === 'alerts:configure') {
      await sendWhatsAppInteractiveMessage(message.from, buildWhatsAppConfigurationList(), config);
      return;
    }

    const update = getWhatsAppPreferenceUpdate(choice);
    if (!update) return;

    await prisma.notificationPreference.update({
      where: { userId: preference.userId },
      data: update as Prisma.NotificationPreferenceUpdateInput,
    });
    await sendWhatsAppInteractiveMessage(message.from, buildWhatsAppQuickReplies(), config);
  }
}

export const whatsappInteractiveController = new WhatsAppInteractiveController();
