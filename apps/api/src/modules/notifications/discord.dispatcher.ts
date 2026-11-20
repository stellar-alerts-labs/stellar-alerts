/**
 * Discord Webhook Dispatcher
 *
 * Re-exports the DiscordNotificationProvider for backwards compatibility
 * and consistency with the Stellar Alerts notification architecture.
 *
 * This module serves as the canonical entry point for dispatching Discord
 * notifications with rich embed formatting, severity-based colors, and
 * rate-limit handling.
 *
 * @see {DiscordNotificationProvider} in ./providers/discord.provider.ts
 */

export {
  DiscordNotificationProvider,
  discordNotificationProvider,
  type DiscordAlertInput,
  type DiscordAlertType,
  type DiscordDispatchOptions,
  type DiscordDispatchResult,
  type DiscordDispatchTarget,
  type DiscordEmbed,
  type DiscordEmbedField,
  type DiscordEmbedFooter,
  type DiscordEmbedThumbnail,
  type DiscordWebhookPayload,
  type DiscordPaymentAlert,
  DISCORD_EMBED_COLORS,
  DISCORD_EMBED_LIMITS,
  STELLAR_ASSET_ICONS,
  getStellarExpertTxLink,
  normalizeAssetCode,
  resolveAssetIcon,
} from './providers/discord.provider';
