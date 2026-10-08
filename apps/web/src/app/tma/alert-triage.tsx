'use client';

import { useCallback, useEffect, useState } from 'react';
import * as haptics from './haptics';
import {
  routeLabel,
  statusBadge,
  formatFeedAmount,
  parseThresholdInput,
  normalizeAssetCode,
  toggleRouteInList,
  type RouteState,
  type AssetThreshold,
  type FeedItem,
  type MiniAppRoute,
} from './alert-triage.helpers';

interface AlertTriagePanelProps {
  apiBase: string;
  initData: string;
}

/**
 * Real-time alert triage & filter tuning surface for the Telegram Mini App
 * (#1006). Reads the live feed / routes / thresholds and lets the user toggle
 * routes and tune per-asset thresholds, each request authenticated by the
 * signed `initData` passed in the `X-Telegram-Init-Data` header. Native haptic
 * feedback fires on every meaningful interaction.
 */
export default function AlertTriagePanel({ apiBase, initData }: AlertTriagePanelProps) {
  const [routes, setRoutes] = useState<RouteState[]>([]);
  const [thresholds, setThresholds] = useState<AssetThreshold[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [assetInput, setAssetInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const initHeaders = useCallback(
    (extra: Record<string, string> = {}): Record<string, string> => ({
      'X-Telegram-Init-Data': initData,
      ...extra,
    }),
    [initData],
  );

  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/notifications/telegram/miniapp/state`, {
        headers: initHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) {
        setRoutes(body.routes ?? []);
        setThresholds(body.thresholds ?? []);
        setFeed(body.feed ?? []);
      }
    } catch {
      /* keep whatever we already have */
    } finally {
      setLoading(false);
    }
  }, [apiBase, initHeaders]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const handleToggleRoute = async (route: MiniAppRoute, next: boolean) => {
    haptics.selection();
    setRoutes((prev) => toggleRouteInList(prev, route, next)); // optimistic
    try {
      const res = await fetch(`${apiBase}/notifications/telegram/miniapp/routes`, {
        method: 'POST',
        headers: initHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ route, enabled: next }),
      });
      if (res.ok) {
        haptics.notify('success');
      } else {
        haptics.notify('error');
        setRoutes((prev) => toggleRouteInList(prev, route, !next)); // rollback
      }
    } catch {
      haptics.notify('error');
      setRoutes((prev) => toggleRouteInList(prev, route, !next));
    }
  };

  const handleSetThreshold = async (event: React.FormEvent) => {
    event.preventDefault();
    const asset = normalizeAssetCode(assetInput);
    if (!asset) {
      setFormError('Enter an asset code.');
      return;
    }
    const parsed = parseThresholdInput(amountInput);
    if (!parsed.ok) {
      setFormError(parsed.error);
      haptics.notify('error');
      return;
    }
    setFormError(null);
    try {
      const res = await fetch(`${apiBase}/notifications/telegram/miniapp/thresholds`, {
        method: 'POST',
        headers: initHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ asset, minAmount: parsed.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) {
        setThresholds(body.thresholds ?? []);
        setAssetInput('');
        setAmountInput('');
        haptics.notify('success');
      } else {
        setFormError(body.error || body.message || 'Could not update threshold.');
        haptics.notify('error');
      }
    } catch {
      setFormError('Network error updating threshold.');
      haptics.notify('error');
    }
  };

  if (loading) {
    return (
      <p className="text-xs text-slate-500" role="status">
        Loading alert triage…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5" data-testid="tma-triage">
      <section
        className="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 flex flex-col gap-3"
        aria-labelledby="tma-routes-title"
      >
        <h2 id="tma-routes-title" className="text-sm font-semibold">
          Notification routes
        </h2>
        <ul className="flex flex-col gap-2">
          {routes.map((r) => (
            <li key={r.route} className="flex items-center justify-between gap-3 text-sm">
              <span>{routeLabel(r.route)}</span>
              <button
                type="button"
                role="switch"
                aria-checked={r.enabled}
                aria-label={`Toggle ${routeLabel(r.route)} alerts`}
                onClick={() => handleToggleRoute(r.route, !r.enabled)}
                className={`w-11 h-6 rounded-full transition-colors ${
                  r.enabled ? 'bg-emerald-500' : 'bg-slate-700'
                } relative`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    r.enabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 flex flex-col gap-3"
        aria-labelledby="tma-thresholds-title"
      >
        <h2 id="tma-thresholds-title" className="text-sm font-semibold">
          Asset thresholds
        </h2>
        {thresholds.length === 0 ? (
          <p className="text-xs text-slate-500">No per-asset thresholds set.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {thresholds.map((t) => (
              <li key={t.asset} className="flex justify-between">
                <span className="font-mono text-cyan-300">{t.asset}</span>
                <span className="text-slate-400">≥ {t.minAmount}</span>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={handleSetThreshold} className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={assetInput}
              onChange={(e) => setAssetInput(e.target.value)}
              placeholder="Asset (e.g. USDC)"
              aria-label="Asset code"
              className="flex-1 rounded-lg bg-slate-950/60 border border-slate-800 px-2 py-1.5 text-xs"
            />
            <input
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              placeholder="Min amount"
              inputMode="decimal"
              aria-label="Minimum amount"
              className="w-24 rounded-lg bg-slate-950/60 border border-slate-800 px-2 py-1.5 text-xs"
            />
          </div>
          {formError && (
            <p className="text-xs text-red-400" role="alert">
              {formError}
            </p>
          )}
          <button
            type="submit"
            className="self-start rounded-lg bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-xs font-semibold px-3 py-1.5"
          >
            Save threshold
          </button>
        </form>
      </section>

      <section
        className="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 flex flex-col gap-3"
        aria-labelledby="tma-feed-title"
      >
        <h2 id="tma-feed-title" className="text-sm font-semibold">
          Live alert feed
        </h2>
        {feed.length === 0 ? (
          <p className="text-xs text-slate-500">No alerts delivered yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {feed.map((item) => {
              const badge = statusBadge(item.status);
              return (
                <li
                  key={item.id}
                  className="rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-2 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-emerald-300">{formatFeedAmount(item)}</span>
                    <span className="block text-slate-500 truncate">{item.channel}</span>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                      badge.tone === 'ok'
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : badge.tone === 'warn'
                          ? 'bg-red-500/15 text-red-300'
                          : 'bg-slate-500/15 text-slate-300'
                    }`}
                  >
                    {badge.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
