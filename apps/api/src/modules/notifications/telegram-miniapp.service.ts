import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import {
  validateTelegramInitData,
  TelegramInitDataError,
  TelegramUser,
} from '../../utils/telegram';

/**
 * Telegram Mini App — Real-Time Alert Triage & Filter Tuning (#1006)
 *
 * Backs the in-bot Mini App that lets mobile users view a live alert feed,
 * toggle notification routes, and tune per-asset thresholds. Every request is
 * authenticated by re-verifying the signed `initData` handed to the WebApp by
 * the Telegram client (HMAC-SHA256 against TELEGRAM_BOT_TOKEN) — the operations
 * mutate notification routing, so they are verified per-request rather than
 * trusting a longer-lived bearer token.
 */

/** Notification routes the Mini App can toggle, mapped to their preference flag. */
export const MINIAPP_ROUTE_FIELDS = {
  telegram: 'telegramEnabled',
  email: 'emailEnabled',
  whatsapp: 'whatsappEnabled',
  discord: 'discordEnabled',
  slack: 'slackEnabled',
  push: 'pushEnabled',
} as const;

export type MiniAppRoute = keyof typeof MINIAPP_ROUTE_FIELDS;

export interface MiniAppRouteState {
  route: MiniAppRoute;
  enabled: boolean;
}

export interface MiniAppFeedItem {
  id: string;
  channel: string;
  status: string;
  amount: string | null;
  asset: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface MiniAppAssetThreshold {
  asset: string;
  minAmount: number;
}

export interface MiniAppSession {
  userId: string;
  telegram: TelegramUser;
}

export interface MiniAppState {
  telegram: TelegramUser;
  routes: MiniAppRouteState[];
  thresholds: MiniAppAssetThreshold[];
  feed: MiniAppFeedItem[];
}

const FEED_LIMIT_DEFAULT = 20;
const FEED_LIMIT_MAX = 100;

/** Type guard for a supported route name. */
export function isMiniAppRoute(value: unknown): value is MiniAppRoute {
  return typeof value === 'string' && value in MINIAPP_ROUTE_FIELDS;
}

/** Maps a route name to the NotificationPreference boolean column it controls. */
export function routeToPreferenceField(route: MiniAppRoute): string {
  return MINIAPP_ROUTE_FIELDS[route];
}

/**
 * Pure merge helper for per-asset thresholds stored inside
 * NotificationPreference.filterRules JSON under the `assetThresholds` key. This
 * keeps threshold tuning migration-free while preserving any other filter blob.
 *
 * Passing `null`/`undefined` (or a non-finite/negative amount) removes the
 * threshold for that asset. Asset codes are upper-cased for canonical storage.
 */
export function applyAssetThreshold(
  existing: unknown,
  asset: string,
  minAmount: number | null | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const current = base.assetThresholds;
  const thresholds: Record<string, number> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, number>) }
      : {};

  const code = asset.trim().toUpperCase();
  if (!code) return base;

  if (minAmount === null || minAmount === undefined || !Number.isFinite(minAmount) || minAmount < 0) {
    delete thresholds[code];
  } else {
    thresholds[code] = minAmount;
  }

  base.assetThresholds = thresholds;
  return base;
}

/** Reads the asset-threshold map out of a filterRules JSON blob. */
export function readAssetThresholds(filterRules: unknown): MiniAppAssetThreshold[] {
  if (!filterRules || typeof filterRules !== 'object' || Array.isArray(filterRules)) return [];
  const raw = (filterRules as Record<string, unknown>).assetThresholds;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  return Object.entries(raw as Record<string, unknown>)
    .filter(([, amount]) => typeof amount === 'number' && Number.isFinite(amount))
    .map(([asset, amount]) => ({ asset, minAmount: amount as number }))
    .sort((a, b) => a.asset.localeCompare(b.asset));
}

/** Clamps a caller-supplied feed limit into the allowed range. */
export function normalizeFeedLimit(limit: unknown): number {
  const n = typeof limit === 'number' ? limit : parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return FEED_LIMIT_DEFAULT;
  return Math.min(Math.trunc(n), FEED_LIMIT_MAX);
}

export class TelegramMiniAppService {
  /**
   * Verifies the Mini App `initData` signature and resolves the backing user.
   * Throws {@link TelegramInitDataError} on any verification failure.
   */
  async authenticate(initData: string): Promise<MiniAppSession> {
    let data;
    try {
      data = validateTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
    } catch (err) {
      if (err instanceof TelegramInitDataError) throw err;
      throw new TelegramInitDataError('MALFORMED', (err as Error).message);
    }

    if (!data.user?.id) {
      throw new TelegramInitDataError('MALFORMED', 'initData did not contain a Telegram user');
    }

    // Mirrors the auth flow's synthetic-email binding so the Mini App and the
    // web session resolve to the same user row.
    const syntheticEmail = `tg_${data.user.id}@telegram.stellar-alerts.org`;
    const user = await prisma.user.upsert({
      where: { email: syntheticEmail },
      update: {},
      create: { email: syntheticEmail },
    });

    return { userId: user.id, telegram: data.user };
  }

  /** Current route toggle state for a user (defaults applied when unset). */
  async getRoutes(userId: string): Promise<MiniAppRouteState[]> {
    const pref = await (prisma as any).notificationPreference.findUnique({ where: { userId } });
    return (Object.keys(MINIAPP_ROUTE_FIELDS) as MiniAppRoute[]).map((route) => ({
      route,
      enabled: Boolean(pref?.[MINIAPP_ROUTE_FIELDS[route]]),
    }));
  }

  /** Flips a single notification route on/off. */
  async toggleRoute(userId: string, route: MiniAppRoute, enabled: boolean): Promise<MiniAppRouteState> {
    const field = routeToPreferenceField(route);
    await (prisma as any).notificationPreference.upsert({
      where: { userId },
      create: { userId, [field]: enabled },
      update: { [field]: enabled },
    });
    return { route, enabled };
  }

  /** Reads the user's per-asset thresholds. */
  async getAssetThresholds(userId: string): Promise<MiniAppAssetThreshold[]> {
    const pref = await (prisma as any).notificationPreference.findUnique({ where: { userId } });
    return readAssetThresholds(pref?.filterRules);
  }

  /** Sets (or clears, when minAmount is null) a per-asset threshold. */
  async setAssetThreshold(
    userId: string,
    asset: string,
    minAmount: number | null,
  ): Promise<MiniAppAssetThreshold[]> {
    const pref = await (prisma as any).notificationPreference.findUnique({ where: { userId } });
    const nextFilterRules = applyAssetThreshold(pref?.filterRules, asset, minAmount);
    await (prisma as any).notificationPreference.upsert({
      where: { userId },
      create: { userId, filterRules: nextFilterRules },
      update: { filterRules: nextFilterRules },
    });
    return readAssetThresholds(nextFilterRules);
  }

  /** Recent notification deliveries for the user, newest first. */
  async getAlertFeed(userId: string, limit: unknown = FEED_LIMIT_DEFAULT): Promise<MiniAppFeedItem[]> {
    const take = normalizeFeedLimit(limit);
    const deliveries = await (prisma as any).notificationDelivery.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      include: { payment: { select: { amount: true, asset: true } } },
    });

    return deliveries.map((d: any) => ({
      id: d.id,
      channel: d.channel,
      status: d.status,
      amount: d.payment?.amount != null ? String(d.payment.amount) : null,
      asset: d.payment?.asset ?? null,
      createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt),
      deliveredAt: d.deliveredAt
        ? d.deliveredAt instanceof Date
          ? d.deliveredAt.toISOString()
          : String(d.deliveredAt)
        : null,
    }));
  }

  /** One-shot bootstrap payload for the Mini App shell. */
  async getState(session: MiniAppSession, feedLimit?: unknown): Promise<MiniAppState> {
    const [routes, thresholds, feed] = await Promise.all([
      this.getRoutes(session.userId),
      this.getAssetThresholds(session.userId),
      this.getAlertFeed(session.userId, feedLimit),
    ]);
    return { telegram: session.telegram, routes, thresholds, feed };
  }
}

export const telegramMiniAppService = new TelegramMiniAppService();
