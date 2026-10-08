/**
 * types.ts — Discord interactive alert actions.
 *
 * Wire types for the subset of the Discord Interactions API this service
 * consumes. Only PING (endpoint verification) and MESSAGE_COMPONENT (button
 * presses) are handled.
 */

/** @see https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-type */
export const DiscordInteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

export type DiscordInteractionTypeValue =
  (typeof DiscordInteractionType)[keyof typeof DiscordInteractionType];

/** @see https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type */
export const DiscordInteractionCallbackType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
} as const;

/** Response flag that keeps a reply visible only to the operator who clicked. */
export const DISCORD_EPHEMERAL_FLAG = 64;

/** Where the interactions endpoint is mounted. */
export const DISCORD_INTERACTIONS_PATH = '/integrations/discord/interactions';

export interface DiscordUser {
  id: string;
  username?: string;
}

export interface DiscordInteractionPayload {
  id?: string;
  type: number;
  application_id?: string;
  token?: string;
  data?: {
    custom_id?: string;
    component_type?: number;
  };
  /** Present when the button was clicked inside a guild. */
  member?: {
    user?: DiscordUser;
  };
  /** Present in DM contexts. */
  user?: DiscordUser;
  message?: {
    id?: string;
    content?: string;
  };
}

export interface DiscordInteractionResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    components?: unknown[];
  };
}

/** Resolve the acting operator id from either the guild or DM shape. */
export function resolveActorId(payload: DiscordInteractionPayload): string {
  return payload.member?.user?.id ?? payload.user?.id ?? 'unknown';
}
