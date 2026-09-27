import { describe, expect, it, vi } from 'vitest';
import { buildAlertConfigurationList, buildAlertQuickActions, parseWhatsAppInteractiveReply, sendWhatsAppInteractiveMessage, thresholdFromReplyId } from '../whatsapp-interactive';

describe('WhatsApp interactive configuration', () => {
  it('builds a list with all supported threshold choices', () => {
    const message = buildAlertConfigurationList('2348012345678');
    expect(message.interactive.type).toBe('list');
    if (message.interactive.type === 'list') expect(message.interactive.action.sections[0].rows).toHaveLength(5);
  });

  it('builds quick actions with enable/disable state', () => {
    const message = buildAlertQuickActions('2348012345678', true);
    if (message.interactive.type === 'button') expect(message.interactive.action.buttons[1].reply).toEqual({ id: 'alerts:disable', title: 'Disable alerts' });
  });

  it('parses Meta list and button replies and rejects unrelated events', () => {
    expect(parseWhatsAppInteractiveReply({ entry: [{ changes: [{ value: { messages: [{ from: '234', interactive: { list_reply: { id: 'threshold:25' } } }] } }] }] })).toEqual({ from: '234', replyId: 'threshold:25', text: undefined });
    expect(parseWhatsAppInteractiveReply({ entry: [] })).toBeNull();
    expect(thresholdFromReplyId('threshold:25')).toBe(25);
    expect(thresholdFromReplyId('threshold:0')).toBeNull();
  });

  it('lets a user start configuration with a plain-text command', () => {
    expect(parseWhatsAppInteractiveReply({ entry: [{ changes: [{ value: { messages: [{ from: '234', text: { body: ' configure ' } }] } }] }] })?.replyId).toBe('alerts:configure');
  });

  it('sends the interactive payload to the Cloud API with bearer auth', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) });
    await sendWhatsAppInteractiveMessage('234', buildAlertQuickActions('234', false), { accessToken: 'secret', phoneNumberId: 'phone', fetch });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/phone/messages'), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret' }) }));
  });
});
