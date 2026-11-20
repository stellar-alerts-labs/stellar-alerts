/**
 * Notification Schemas
 *
 * Shared type definitions and validation schemas for multi-channel
 * notification dispatch (Discord, Slack, Telegram, Email, Push Protocol,
 * PagerDuty, Opsgenie, WhatsApp).
 */

/**
 * Supported notification channels
 */
export type NotificationChannel =
  | 'telegram'
  | 'email'
  | 'whatsapp'
  | 'discord'
  | 'slack'
  | 'push'
  | 'pagerduty'
  | 'opsgenie';

/**
 * Alert severity levels (maps to Discord/Slack colors and PagerDuty/Opsgenie priorities)
 */
export type AlertSeverity =
  | 'critical'
  | 'fatal'
  | 'error'
  | 'high'
  | 'warning'
  | 'medium'
  | 'info'
  | 'low'
  | 'success';

/**
 * Base notification payload for payment alerts
 */
export interface BaseNotificationPayload {
  paymentId?: string;
  alertId?: string;
  txHash: string;
  amount?: string | number;
  asset?: string;
  assetIssuer?: string | null;
  fromAddress?: string;
  recipientAddress?: string;
  memo?: string;
  receivedAt: string | Date;
  network?: string;
  severity?: AlertSeverity | null;
}

/**
 * Contract event notification payload
 */
export interface ContractNotificationPayload extends Omit<BaseNotificationPayload, 'amount'> {
  contractId: string;
  eventType: string;
  eventData?: Record<string, unknown>;
}

/**
 * Discord-specific notification configuration
 */
export interface DiscordNotificationConfig {
  webhookUrl: string;
  username?: string;
  avatarUrl?: string;
  embedColor?: number;
}

/**
 * Slack-specific notification configuration
 */
export interface SlackNotificationConfig {
  webhookUrl?: string;
  botToken?: string;
  channel?: string;
  username?: string;
  iconEmoji?: string;
}

/**
 * Notification dispatch result
 */
export interface NotificationDispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  rateLimited?: boolean;
  retryAfterSeconds?: number;
  attempts?: number;
  channel?: NotificationChannel;
}

/**
 * Notification preference update request
 */
export interface NotificationPreferenceUpdate {
  telegramChatId?: string | null;
  telegramEnabled?: boolean;
  emailEnabled?: boolean;
  whatsappNumber?: string | null;
  whatsappEnabled?: boolean;
  discordWebhookUrl?: string | null;
  discordEnabled?: boolean;
  slackWebhookUrl?: string | null;
  slackEnabled?: boolean;
  pushChannelAddress?: string | null;
  pushEnabled?: boolean;
  pagerDutyRoutingKey?: string | null;
  pagerDutyEnabled?: boolean;
  opsgenieApiKey?: string | null;
  opsgenieEnabled?: boolean;
  enabledChannels?: NotificationChannel[];
  assetFilters?: string[];
  minAmount?: number | string | null;
  receiptPreference?: 'instant' | 'daily_digest' | 'summary';
  digestFrequency?: 'daily' | 'weekly' | 'off';
  language?: string;
  filterRules?: unknown;
}

/**
 * Notification delivery status
 */
export interface NotificationDeliveryStatus {
  channel: NotificationChannel;
  delivered: boolean;
  timestamp: Date;
  error?: string;
  statusCode?: number;
}

/**
 * Batch notification dispatch request
 */
export interface BatchNotificationRequest {
  userId: string;
  alerts: (BaseNotificationPayload | ContractNotificationPayload)[];
  channels: NotificationChannel[];
  priority?: 'high' | 'normal' | 'low';
}

/**
 * Rate limit information for notification providers
 */
export interface RateLimitInfo {
  resetAt?: Date;
  retryAfter?: number;
  remaining?: number;
  limit?: number;
}

/**
 * Webhook validation result
 */
export interface WebhookValidationResult {
  valid: boolean;
  error?: string;
  provider?: 'discord' | 'slack' | 'generic';
}
