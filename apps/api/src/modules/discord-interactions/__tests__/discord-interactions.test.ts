import crypto from 'node:crypto';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  DEFAULT_SNOOZE_DURATIONS,
  buildAlertCustomId,
  buildDiscordAlertComponents,
  buildDiscordEmbed,
  dispatchDiscordAlert,
  parseAlertCustomId,
} from '../../../utils/discord';
import {
  InMemoryDiscordAlertActionStore,
  DiscordInteractionsService,
  DISCORD_INTERACTIONS_PATH,
  DISCORD_EPHEMERAL_FLAG,
  DiscordInteractionCallbackType,
  DiscordInteractionType,
  exportRawEd25519PublicKey,
  isFreshDiscordTimestamp,
  verifyDiscordRequest,
  verifyDiscordSignature,
} from '../index';
import type { DiscordInteractionPayload } from '../index';

const FIXED_NOW = new Date('2026-09-27T12:00:00.000Z');

function makeService(options: { allowedSnoozeDurations?: readonly number[] } = {}) {
  return new DiscordInteractionsService({
    store: new InMemoryDiscordAlertActionStore(() => FIXED_NOW),
    now: () => FIXED_NOW,
    allowedSnoozeDurations: options.allowedSnoozeDurations,
  });
}

function componentInteraction(customId: string, actorId = 'operator-1'): DiscordInteractionPayload {
  return {
    id: 'interaction-1',
    type: DiscordInteractionType.MESSAGE_COMPONENT,
    data: { custom_id: customId, component_type: 2 },
    member: { user: { id: actorId, username: 'operator' } },
  };
}

describe('Discord custom_id codec', () => {
  it('round-trips acknowledge, snooze, and re-route ids', () => {
    expect(parseAlertCustomId(buildAlertCustomId('ack', 'alert-1'))).toEqual({
      action: 'ack',
      alertId: 'alert-1',
      param: undefined,
    });
    expect(parseAlertCustomId(buildAlertCustomId('snooze', 'alert-1', 3600))).toEqual({
      action: 'snooze',
      alertId: 'alert-1',
      param: '3600',
    });
    expect(parseAlertCustomId(buildAlertCustomId('reroute', 'alert-9', 'oncall'))).toEqual({
      action: 'reroute',
      alertId: 'alert-9',
      param: 'oncall',
    });
  });

  it('rejects ids from other bots, unknown actions, and truncated payloads', () => {
    expect(parseAlertCustomId('other:v1:ack:alert-1')).toBeNull();
    expect(parseAlertCustomId('sa:v1:delete:alert-1')).toBeNull();
    expect(parseAlertCustomId('sa:v1:ack')).toBeNull();
    expect(parseAlertCustomId(undefined)).toBeNull();
    expect(parseAlertCustomId('')).toBeNull();
  });

  it('requires an alert id when building', () => {
    expect(() => buildAlertCustomId('ack', '')).toThrow(/alertId/);
  });
});

describe('buildDiscordAlertComponents', () => {
  it('builds an action row with acknowledge, snooze and re-route buttons', () => {
    const rows = buildDiscordAlertComponents('alert-42');

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(1);
    expect(rows[0].components).toHaveLength(4);
    expect(rows[0].components[0]).toMatchObject({
      label: 'Acknowledge',
      custom_id: 'sa:v1:ack:alert-42',
    });
    expect(rows[0].components[1].custom_id).toBe(`sa:v1:snooze:alert-42:${DEFAULT_SNOOZE_DURATIONS[0]}`);
    expect(rows[0].components[1].label).toBe('Snooze 1h');
    expect(rows[0].components[3].custom_id).toBe('sa:v1:reroute:alert-42:default');
  });

  it('honours custom snooze windows and can omit the re-route button', () => {
    const rows = buildDiscordAlertComponents('alert-7', {
      snoozeDurations: [900, 7200],
      allowReroute: false,
    });

    expect(rows[0].components.map((component) => component.label)).toEqual([
      'Acknowledge',
      'Snooze 15m',
      'Snooze 2h',
    ]);
  });

  it('never exceeds the 5-component action row limit', () => {
    const rows = buildDiscordAlertComponents('alert-7', {
      snoozeDurations: [60, 300, 900, 3600, 86400],
    });
    expect(rows[0].components.length).toBeLessThanOrEqual(5);
  });
});

describe('buildDiscordEmbed with interactive components', () => {
  const baseData = {
    paymentId: 'pay_1',
    txHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    amount: '100.5',
    asset: 'USDC',
    assetIssuer: null,
    fromAddress: 'GABC123',
    receivedAt: '2026-08-25T12:00:00.000Z',
  };

  it('omits components by default so existing alert payloads are unchanged', () => {
    expect(buildDiscordEmbed(baseData).components).toBeUndefined();
  });

  it('attaches components when supplied', () => {
    const payload = buildDiscordEmbed(baseData, { components: buildDiscordAlertComponents('alert-1') });
    expect(payload.components).toHaveLength(1);
    expect(payload.components?.[0].components[0].custom_id).toBe('sa:v1:ack:alert-1');
  });
});

describe('dispatchDiscordAlert', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes interactive buttons when an alertId is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    await dispatchDiscordAlert('https://discord.com/api/webhooks/1/x', {
      paymentId: 'pay_1',
      txHash: 'abc',
      amount: '1',
      asset: 'XLM',
      fromAddress: 'GABC',
      receivedAt: '2026-08-25T12:00:00.000Z',
    }, { alertId: 'alert-5' });

    const [, options] = fetchMock.mock.calls[0];
    const sent = JSON.parse(options.body);
    expect(sent.components[0].components[0].custom_id).toBe('sa:v1:ack:alert-5');
  });

  it('stays button-free when no alertId is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    await dispatchDiscordAlert('https://discord.com/api/webhooks/1/x', {
      paymentId: 'pay_1',
      txHash: 'abc',
      amount: '1',
      asset: 'XLM',
      fromAddress: 'GABC',
      receivedAt: '2026-08-25T12:00:00.000Z',
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body).components).toBeUndefined();
  });
});

describe('verifyDiscordSignature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyHex = exportRawEd25519PublicKey(publicKey);
  const timestamp = '1790000000';
  const body = JSON.stringify({ type: 1 });

  function sign(payload: string, ts = timestamp): string {
    return crypto.sign(null, Buffer.from(ts + payload, 'utf8'), privateKey).toString('hex');
  }

  it('accepts a valid signature over timestamp + body', () => {
    expect(verifyDiscordSignature({ publicKeyHex, signatureHex: sign(body), timestamp, body })).toBe(true);
    expect(
      verifyDiscordRequest({ publicKeyHex, signatureHex: sign(body), timestamp, body, nowMs: 1790000000 * 1000 }).ok,
    ).toBe(true);
  });

  it('rejects a signature covering a different body', () => {
    expect(
      verifyDiscordSignature({ publicKeyHex, signatureHex: sign(body), timestamp, body: '{"type":3}' }),
    ).toBe(false);
  });

  it('reports precise failure reasons for malformed input', () => {
    expect(
      verifyDiscordRequest({ publicKeyHex: '', signatureHex: 'aa', timestamp, body }).ok,
    ).toBe(false);
    const missing = verifyDiscordRequest({ publicKeyHex, signatureHex: '', timestamp: '', body });
    expect(missing.ok === false && missing.reason).toBe('missing_headers');

    const badKey = verifyDiscordRequest({ publicKeyHex: 'zz', signatureHex: sign(body), timestamp, body });
    expect(badKey.ok === false && badKey.reason).toBe('malformed_key');

    const badSig = verifyDiscordRequest({ publicKeyHex, signatureHex: 'abcd', timestamp, body });
    expect(badSig.ok === false && badSig.reason).toBe('malformed_signature');

    const stale = verifyDiscordRequest({
      publicKeyHex,
      signatureHex: sign(body),
      timestamp,
      body,
      nowMs: 1790000000 * 1000 + 10 * 60 * 1000,
    });
    expect(stale.ok === false && stale.reason).toBe('stale_timestamp');
  });

  it('guards the replay window', () => {
    expect(isFreshDiscordTimestamp('1790000000', 1790000000 * 1000)).toBe(true);
    expect(isFreshDiscordTimestamp('1790000000', 1790000000 * 1000 + 6 * 60 * 1000)).toBe(false);
    expect(isFreshDiscordTimestamp('not-a-number')).toBe(false);
  });
});

describe('DiscordInteractionsService', () => {
  let service: DiscordInteractionsService;

  beforeEach(() => {
    service = makeService();
  });

  it('answers the Discord PING handshake', async () => {
    const response = await service.handle({ type: DiscordInteractionType.PING });
    expect(response).toEqual({ type: DiscordInteractionCallbackType.PONG });
  });

  it('acknowledges an alert and records the operator', async () => {
    const response = await service.handle(componentInteraction(buildAlertCustomId('ack', 'alert-1'), 'op-7'));

    expect(response.type).toBe(DiscordInteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(response.data?.flags).toBe(DISCORD_EPHEMERAL_FLAG);
    expect(response.data?.content).toMatch(/acknowledged/i);
    expect(response.data?.content).toContain('op-7');

    const state = await service.getAlertState('alert-1');
    expect(state?.status).toBe('acknowledged');
    expect(state?.actorId).toBe('op-7');
    expect(state?.history).toHaveLength(1);
  });

  it('snoozes an alert until the requested window elapses', async () => {
    await service.handle(componentInteraction(buildAlertCustomId('snooze', 'alert-2', 3600)));

    const state = await service.getAlertState('alert-2');
    expect(state?.status).toBe('snoozed');
    expect(state?.snoozedUntil).toBe(new Date(FIXED_NOW.getTime() + 3600 * 1000).toISOString());
  });

  it('re-routes an alert to the requested destination', async () => {
    await service.handle(componentInteraction(buildAlertCustomId('reroute', 'alert-3', 'oncall')));

    const state = await service.getAlertState('alert-3');
    expect(state?.status).toBe('rerouted');
    expect(state?.routedTo).toBe('oncall');
  });

  it('accumulates a history across repeated actions', async () => {
    await service.handle(componentInteraction(buildAlertCustomId('ack', 'alert-4'), 'op-a'));
    await service.handle(componentInteraction(buildAlertCustomId('snooze', 'alert-4', 900), 'op-b'));

    const state = await service.getAlertState('alert-4');
    expect(state?.history.map((entry) => entry.action)).toEqual(['ack', 'snooze']);
    expect(state?.actorId).toBe('op-b');
  });

  it('returns an ephemeral error for unknown button ids', async () => {
    const response = await service.handle(componentInteraction('totally-unknown'));
    expect(response.data?.flags).toBe(DISCORD_EPHEMERAL_FLAG);
    expect(response.data?.content).toContain('no longer supported');
  });

  it('rejects an unidentified operator', async () => {
    const response = await service.handle({
      type: DiscordInteractionType.MESSAGE_COMPONENT,
      data: { custom_id: buildAlertCustomId('ack', 'alert-6') },
    });
    expect(response.data?.content).toContain('identify');
  });

  it('rejects invalid and disallowed snooze durations', async () => {
    const invalid = await service.handle(
      componentInteraction(buildAlertCustomId('snooze', 'alert-8', 0)),
    );
    expect(invalid.data?.content).toContain('Invalid snooze duration');

    const restricted = makeService({ allowedSnoozeDurations: [3600] });
    const disallowed = await restricted.handle(
      componentInteraction(buildAlertCustomId('snooze', 'alert-8', 900)),
    );
    expect(disallowed.data?.content).toContain('not allowed');
  });

  it('exposes interactive components for alert messages', () => {
    const rows = service.buildAlertComponents('alert-11');
    expect(rows[0].components.some((component) => component.custom_id === 'sa:v1:ack:alert-11')).toBe(true);
  });

  it('ignores unsupported interaction types', async () => {
    const response = await service.handle({ type: DiscordInteractionType.APPLICATION_COMMAND });
    expect(response.data?.content).toContain('Unsupported interaction type');
  });
});

describe('Discord interactions contract', () => {
  it('mounts the endpoint at the path Discord is configured with', () => {
    expect(DISCORD_INTERACTIONS_PATH).toBe('/integrations/discord/interactions');
  });
});
