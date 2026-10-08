import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWhatsAppConfigurationList,
  buildWhatsAppQuickReplies,
  sendWhatsAppInteractiveMessage,
  verifyWhatsAppWebhookSignature,
  matchesWhatsAppPreferences,
  getWhatsAppPreferenceUpdate,
} from '../whatsapp-interactive';

describe('WhatsApp interactive configuration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers threshold and asset filters as list choices', () => {
    const payload = buildWhatsAppConfigurationList();
    expect(payload.interactive.type).toBe('list');
    expect(payload.interactive.action.sections.flatMap((section) => section.rows.map((row) => row.id))).toEqual([
      'threshold:any', 'threshold:10', 'threshold:50', 'threshold:100', 'asset:any', 'asset:XLM', 'asset:USDC',
    ]);
  });

  it('exposes quick reply buttons to enable, disable, or configure alerts', () => {
    const payload = buildWhatsAppQuickReplies();
    expect(payload.interactive.action.buttons.map(({ reply }) => reply.id)).toEqual([
      'alerts:on', 'alerts:off', 'alerts:configure',
    ]);
  });

  it('applies configured minimum amount and asset filters to WhatsApp delivery', () => {
    expect(matchesWhatsAppPreferences({ amount: '12', asset: 'XLM' }, { minAmount: '10', assetFilters: ['XLM'] })).toBe(true);
    expect(matchesWhatsAppPreferences({ amount: '9', asset: 'XLM' }, { minAmount: '10', assetFilters: ['XLM'] })).toBe(false);
    expect(matchesWhatsAppPreferences({ amount: '12', asset: 'USDC' }, { minAmount: null, assetFilters: ['XLM'] })).toBe(false);
    expect(matchesWhatsAppPreferences({ amount: '12', asset: 'native' }, { minAmount: null, assetFilters: ['XLM'] })).toBe(true);
    expect(matchesWhatsAppPreferences({ amount: '0.1', asset: 'USDC' }, { minAmount: null, assetFilters: [] })).toBe(true);
  });

  it('maps only allowlisted interactive choices to preference updates', () => {
    expect(getWhatsAppPreferenceUpdate('threshold:50')).toEqual({ minAmount: '50' });
    expect(getWhatsAppPreferenceUpdate('asset:USDC')).toEqual({ assetFilters: ['USDC'] });
    expect(getWhatsAppPreferenceUpdate('alerts:off')).toEqual({ whatsappEnabled: false });
    expect(getWhatsAppPreferenceUpdate('threshold:999')).toBeNull();
    expect(getWhatsAppPreferenceUpdate('arbitrary:text')).toBeNull();
  });

  it('verifies the exact raw-body HMAC and rejects malformed or changed signatures', () => {
    const body = Buffer.from('{"entry":[]}');
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    expect(verifyWhatsAppWebhookSignature(body, signature, 'app-secret')).toBe(true);
    expect(verifyWhatsAppWebhookSignature(Buffer.from('{}'), signature, 'app-secret')).toBe(false);
    expect(verifyWhatsAppWebhookSignature(body, undefined, 'app-secret')).toBe(false);
  });

  it('sends interactive payloads through the Cloud API endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendWhatsAppInteractiveMessage('+14155551234', buildWhatsAppQuickReplies(), {
      accessToken: 'token', phoneNumberId: '12345',
    });
    expect(result.messages?.[0].id).toBe('wamid.1');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v23.0/12345/messages'), expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).interactive.type).toBe('button');
  });
});
