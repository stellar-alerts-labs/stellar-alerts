import { createHmac, timingSafeEqual } from 'node:crypto';

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';

export interface WhatsAppInteractiveConfig {
  accessToken: string;
  phoneNumberId: string;
}

/** Applies the chat-configured channel filters to a payment before WhatsApp delivery. */
export function matchesWhatsAppPreferences(
  payment: { amount: string | number; asset: string },
  preferences: { minAmount?: unknown; assetFilters?: unknown },
): boolean {
  const minimum = preferences.minAmount == null ? null : Number(preferences.minAmount);
  if (minimum !== null && Number.isFinite(minimum) && Number(payment.amount) < minimum) return false;
  const assets = Array.isArray(preferences.assetFilters)
    ? preferences.assetFilters.filter((asset): asset is string => typeof asset === 'string')
    : [];
  const normalizedAsset = payment.asset === 'native' ? 'XLM' : payment.asset;
  return assets.length === 0 || assets.includes(normalizedAsset);
}

/** Maps only the IDs emitted by our interactive UI to safe preference updates. */
export function getWhatsAppPreferenceUpdate(choice: string): Record<string, unknown> | null {
  if (choice === 'alerts:on') return { whatsappEnabled: true };
  if (choice === 'alerts:off') return { whatsappEnabled: false };
  if (choice.startsWith('threshold:')) {
    const amount = choice.slice('threshold:'.length);
    if (amount === 'any') return { minAmount: null };
    if (['10', '50', '100'].includes(amount)) return { minAmount: amount };
  }
  if (choice.startsWith('asset:')) {
    const asset = choice.slice('asset:'.length);
    if (asset === 'any') return { assetFilters: [] };
    if (['XLM', 'USDC'].includes(asset)) return { assetFilters: [asset] };
  }
  return null;
}

/** Cloud API list message used to expose common alert settings in one tap. */
export function buildWhatsAppConfigurationList() {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'Choose a setting to update your Stellar payment alerts.' },
      action: {
        button: 'Configure alerts',
        sections: [
          {
            title: 'Minimum payment',
            rows: [
              { id: 'threshold:any', title: 'Any amount', description: 'Receive alerts for every payment' },
              { id: 'threshold:10', title: 'At least 10 XLM' },
              { id: 'threshold:50', title: 'At least 50 XLM' },
              { id: 'threshold:100', title: 'At least 100 XLM' },
            ],
          },
          {
            title: 'Asset filter',
            rows: [
              { id: 'asset:any', title: 'All assets' },
              { id: 'asset:XLM', title: 'XLM only' },
              { id: 'asset:USDC', title: 'USDC only' },
            ],
          },
        ],
      },
    },
  };
}

export function buildWhatsAppQuickReplies() {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'WhatsApp payment alerts' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'alerts:on', title: 'Turn on' } },
          { type: 'reply', reply: { id: 'alerts:off', title: 'Turn off' } },
          { type: 'reply', reply: { id: 'alerts:configure', title: 'Configure' } },
        ],
      },
    },
  };
}

export function verifyWhatsAppWebhookSignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature) || !appSecret) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`);
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function sendWhatsAppInteractiveMessage(
  recipient: string,
  interactive: ReturnType<typeof buildWhatsAppConfigurationList> | ReturnType<typeof buildWhatsAppQuickReplies>,
  config: WhatsAppInteractiveConfig,
) {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, ...interactive }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`WhatsApp Cloud API responded with status ${response.status}`);
  return response.json() as Promise<{ messages?: Array<{ id: string }> }>;
}
