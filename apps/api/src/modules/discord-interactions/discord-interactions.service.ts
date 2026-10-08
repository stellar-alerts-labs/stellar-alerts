/**
 * service.ts — Discord interactive alert actions (acknowledge / snooze / re-route).
 *
 * Turns a verified Discord MESSAGE_COMPONENT interaction into a state change
 * on the referenced alert. The service is transport-agnostic: it takes a
 * parsed interaction payload and returns the Discord interaction response, so
 * it can be unit tested without Fastify, HTTP, or a live Discord application.
 */
import {
  buildDiscordAlertComponents,
  parseAlertCustomId,
  type DiscordActionRow,
} from '../../utils/discord';
import {
  InMemoryDiscordAlertActionStore,
  type DiscordAlertActionState,
  type DiscordAlertActionStore,
} from './discord-interactions.actionStore';
import {
  DISCORD_EPHEMERAL_FLAG,
  DiscordInteractionCallbackType,
  DiscordInteractionType,
  resolveActorId,
  type DiscordInteractionPayload,
  type DiscordInteractionResponse,
} from './discord-interactions.types';

/** Upper bound for an ad-hoc snooze duration (7 days). */
export const MAX_SNOOZE_SECONDS = 7 * 24 * 60 * 60;

export interface DiscordInteractionsServiceOptions {
  store?: DiscordAlertActionStore;
  now?: () => Date;
  /**
   * When supplied, only these snooze windows are accepted. Defaults to any
   * positive integer up to `MAX_SNOOZE_SECONDS`.
   */
  allowedSnoozeDurations?: readonly number[];
}

export class DiscordInteractionsService {
  private readonly store: DiscordAlertActionStore;
  private readonly now: () => Date;
  private readonly allowedSnoozeDurations?: readonly number[];

  constructor(options: DiscordInteractionsServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.store = options.store ?? new InMemoryDiscordAlertActionStore(this.now);
    this.allowedSnoozeDurations = options.allowedSnoozeDurations;
  }

  /** Components to attach to an alert message so operators can act on it. */
  buildAlertComponents(alertId: string): DiscordActionRow[] {
    return buildDiscordAlertComponents(alertId);
  }

  /** Current action state for an alert, or null when untouched. */
  async getAlertState(alertId: string): Promise<DiscordAlertActionState | null> {
    return this.store.get(alertId);
  }

  /**
   * Entry point for `POST /integrations/discord/interactions`.
   * Callers MUST verify the Ed25519 signature before invoking this.
   */
  async handle(payload: DiscordInteractionPayload): Promise<DiscordInteractionResponse> {
    if (payload.type === DiscordInteractionType.PING) {
      return { type: DiscordInteractionCallbackType.PONG };
    }

    if (payload.type !== DiscordInteractionType.MESSAGE_COMPONENT) {
      return this.ephemeral('❌ Unsupported interaction type.');
    }

    const parsed = parseAlertCustomId(payload.data?.custom_id);
    if (!parsed) {
      return this.ephemeral('❌ This button is no longer supported. Refresh the alert message.');
    }

    const actorId = resolveActorId(payload);
    if (actorId === 'unknown') {
      return this.ephemeral('❌ Could not identify the operator who pressed this button.');
    }

    const validationError = this.validateAction(parsed.action, parsed.param);
    if (validationError) {
      return this.ephemeral(validationError);
    }

    const state = await this.store.apply({
      action: parsed.action,
      alertId: parsed.alertId,
      actorId,
      snoozeSeconds: parsed.action === 'snooze' ? Number(parsed.param) : undefined,
      routedTo: parsed.action === 'reroute' ? parsed.param : undefined,
    });

    return this.ephemeral(this.buildConfirmation(state), this.buildAlertComponents(parsed.alertId));
  }

  private validateAction(action: string, param?: string): string | null {
    if (action === 'snooze') {
      const seconds = Number(param);
      if (!Number.isInteger(seconds) || seconds <= 0) {
        return '❌ Invalid snooze duration.';
      }
      if (this.allowedSnoozeDurations && !this.allowedSnoozeDurations.includes(seconds)) {
        return '❌ That snooze duration is not allowed.';
      }
      if (seconds > MAX_SNOOZE_SECONDS) {
        return '❌ Snooze duration is too long.';
      }
    }
    return null;
  }

  private buildConfirmation(state: DiscordAlertActionState): string {
    switch (state.status) {
      case 'acknowledged':
        return `✅ Alert acknowledged by <@${state.actorId}>.`;
      case 'snoozed':
        return `⏰ Alert snoozed by <@${state.actorId}> until ${state.snoozedUntil}.`;
      case 'rerouted':
        return `🔀 Alert re-routed by <@${state.actorId}> to \`${state.routedTo}\`.`;
      default:
        return '✅ Alert updated.';
    }
  }

  private ephemeral(content: string, components?: DiscordActionRow[]): DiscordInteractionResponse {
    return {
      type: DiscordInteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content,
        flags: DISCORD_EPHEMERAL_FLAG,
        ...(components ? { components } : {}),
      },
    };
  }
}

export const discordInteractionsService = new DiscordInteractionsService();
