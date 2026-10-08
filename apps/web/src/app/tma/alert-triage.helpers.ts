/**
 * Pure helpers for the Telegram Mini App alert-triage view (#1006). No DOM / SDK
 * access here so feed formatting, route labelling, and threshold validation can
 * be unit-tested in isolation.
 */

export type MiniAppRoute = 'telegram' | 'email' | 'whatsapp' | 'discord' | 'slack' | 'push';

export interface RouteState {
  route: MiniAppRoute;
  enabled: boolean;
}

export interface AssetThreshold {
  asset: string;
  minAmount: number;
}

export interface FeedItem {
  id: string;
  channel: string;
  status: string;
  amount: string | null;
  asset: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

const ROUTE_LABELS: Record<MiniAppRoute, string> = {
  telegram: 'Telegram',
  email: 'Email',
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  slack: 'Slack',
  push: 'Push',
};

export function routeLabel(route: MiniAppRoute): string {
  return ROUTE_LABELS[route] ?? route;
}

/** Maps a delivery status to a compact status badge descriptor. */
export function statusBadge(status: string): { label: string; tone: 'ok' | 'warn' | 'pending' } {
  const normalized = status.toLowerCase();
  if (normalized === 'delivered' || normalized === 'success') {
    return { label: 'Delivered', tone: 'ok' };
  }
  if (normalized === 'failed' || normalized === 'suppressed' || normalized === 'dead') {
    return { label: normalized === 'failed' ? 'Failed' : 'Suppressed', tone: 'warn' };
  }
  return { label: 'Pending', tone: 'pending' };
}

/** Formats a feed item's amount/asset for display, tolerating missing data. */
export function formatFeedAmount(item: Pick<FeedItem, 'amount' | 'asset'>): string {
  if (!item.amount) return '—';
  return item.asset ? `${item.amount} ${item.asset}` : item.amount;
}

/**
 * Validates a threshold input string. Returns the parsed number when valid, or
 * `null` (with a reason) when not. An empty string is treated as "clear the
 * threshold" and returns `{ value: null, cleared: true }`.
 */
export function parseThresholdInput(
  raw: string,
): { ok: true; value: number | null; cleared: boolean } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null, cleared: true };

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, error: 'Enter a number.' };
  if (value < 0) return { ok: false, error: 'Threshold cannot be negative.' };

  return { ok: true, value, cleared: false };
}

/** Normalises an asset code the way the backend stores it (trimmed, upper-case). */
export function normalizeAssetCode(asset: string): string {
  return asset.trim().toUpperCase();
}

/** Applies an optimistic route toggle to a route list without mutating input. */
export function toggleRouteInList(
  routes: RouteState[],
  route: MiniAppRoute,
  enabled: boolean,
): RouteState[] {
  return routes.map((r) => (r.route === route ? { ...r, enabled } : r));
}
