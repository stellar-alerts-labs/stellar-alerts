import { describe, it, expect } from 'vitest';
import {
  routeLabel,
  statusBadge,
  formatFeedAmount,
  parseThresholdInput,
  normalizeAssetCode,
  toggleRouteInList,
  type RouteState,
} from './alert-triage.helpers';

describe('alert-triage.helpers (#1006)', () => {
  describe('routeLabel', () => {
    it('gives a friendly label for each route', () => {
      expect(routeLabel('telegram')).toBe('Telegram');
      expect(routeLabel('whatsapp')).toBe('WhatsApp');
    });
  });

  describe('statusBadge', () => {
    it('maps delivery statuses to tones', () => {
      expect(statusBadge('delivered').tone).toBe('ok');
      expect(statusBadge('SUCCESS').tone).toBe('ok');
      expect(statusBadge('failed').tone).toBe('warn');
      expect(statusBadge('suppressed').label).toBe('Suppressed');
      expect(statusBadge('pending').tone).toBe('pending');
      expect(statusBadge('anything-else').tone).toBe('pending');
    });
  });

  describe('formatFeedAmount', () => {
    it('joins amount and asset, tolerating missing data', () => {
      expect(formatFeedAmount({ amount: '100', asset: 'USDC' })).toBe('100 USDC');
      expect(formatFeedAmount({ amount: '100', asset: null })).toBe('100');
      expect(formatFeedAmount({ amount: null, asset: 'USDC' })).toBe('—');
    });
  });

  describe('parseThresholdInput', () => {
    it('treats empty input as a clear', () => {
      expect(parseThresholdInput('   ')).toEqual({ ok: true, value: null, cleared: true });
    });

    it('parses a valid non-negative number', () => {
      expect(parseThresholdInput('250')).toEqual({ ok: true, value: 250, cleared: false });
    });

    it('rejects non-numeric and negative input', () => {
      expect(parseThresholdInput('abc').ok).toBe(false);
      expect(parseThresholdInput('-3').ok).toBe(false);
    });
  });

  describe('normalizeAssetCode', () => {
    it('trims and upper-cases', () => {
      expect(normalizeAssetCode(' usdc ')).toBe('USDC');
    });
  });

  describe('toggleRouteInList', () => {
    it('flips only the targeted route without mutating the input', () => {
      const routes: RouteState[] = [
        { route: 'telegram', enabled: true },
        { route: 'email', enabled: false },
      ];
      const next = toggleRouteInList(routes, 'email', true);
      expect(next).toEqual([
        { route: 'telegram', enabled: true },
        { route: 'email', enabled: true },
      ]);
      expect(routes[1].enabled).toBe(false); // original untouched
    });
  });
});
