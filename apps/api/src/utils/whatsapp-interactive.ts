import { createAmountThresholdRule, FilterRuleGroup } from '../lib/rules-engine';

export interface WhatsAppCloudConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
}

export interface WhatsAppInteractiveMessage {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'interactive';
  interactive:
    | { type: 'list'; body: { text: string }; action: { button: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> } }
    | { type: 'button'; body: { text: string }; action: { buttons: Array<{ type: 'reply'; reply: { id: string; title: string } }> } };
}

export const WHATSAPP_THRESHOLD_OPTIONS = [10, 25, 50, 100, 500] as const;

export function buildAlertConfigurationList(to: string): WhatsAppInteractiveMessage {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'list', body: { text: 'Choose the minimum XLM amount that should trigger a Stellar alert.' },
      action: { button: 'Choose threshold', sections: [{ title: 'Minimum amount', rows: WHATSAPP_THRESHOLD_OPTIONS.map((amount) => ({
        id: `threshold:${amount}`, title: `${amount} XLM`, description: `Alert for payments of ${amount} XLM or more`,
      })) }] },
    },
  };
}

export function buildAlertQuickActions(to: string, enabled: boolean): WhatsAppInteractiveMessage {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'button', body: { text: 'What would you like to do with Stellar Alerts?' },
      action: { buttons: [
        { type: 'reply', reply: { id: 'alerts:configure', title: 'Set threshold' } },
        { type: 'reply', reply: { id: enabled ? 'alerts:disable' : 'alerts:enable', title: enabled ? 'Disable alerts' : 'Enable alerts' } },
        { type: 'reply', reply: { id: 'alerts:help', title: 'Help' } },
      ] },
    },
  };
}

export function buildConfigurationConfirmation(to: string, amount: number): WhatsAppInteractiveMessage {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: { type: 'button', body: { text: `Your alert threshold is now ${amount} XLM or more.` }, action: { buttons: [
      { type: 'reply', reply: { id: 'alerts:configure', title: 'Change it' } },
      { type: 'reply', reply: { id: 'alerts:disable', title: 'Disable alerts' } },
    ] } },
  };
}

export async function sendWhatsAppInteractiveMessage(to: string, message: WhatsAppInteractiveMessage, config: WhatsAppCloudConfig) {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`https://graph.facebook.com/${config.apiVersion ?? 'v21.0'}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? `WhatsApp Cloud API responded with status ${response.status}`);
  return body as { messages?: Array<{ id: string }> };
}

export interface WhatsAppInteractiveReply { from: string; replyId?: string; text?: string; }

export function parseWhatsAppInteractiveReply(payload: any): WhatsAppInteractiveReply | null {
  const message = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message?.from) return null;
  const text = message.text?.body;
  const normalizedText = typeof text === 'string' ? text.trim().toLowerCase() : '';
  const replyId = message.interactive?.list_reply?.id
    ?? message.interactive?.button_reply?.id
    ?? (normalizedText === 'configure' || normalizedText === 'menu' ? 'alerts:configure' : normalizedText === 'help' ? 'alerts:help' : undefined);
  return { from: message.from, replyId, text };
}

export function thresholdFromReplyId(replyId: string): number | null {
  const match = /^threshold:(\d+(?:\.\d+)?)$/.exec(replyId);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function thresholdFilter(amount: number): FilterRuleGroup { return createAmountThresholdRule(amount); }
