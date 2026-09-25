/**
 * Typed accessor for the `NotificationPreference.filterRules` Prisma Json
 * column, replacing the `(notifyPrefs as any)?.filterRules` cast in the
 * watcher worker.
 *
 * Prisma models `Json` columns as `Prisma.JsonValue` at the TypeScript
 * level, which is `string | number | boolean | null | JsonObject |
 * JsonArray`.  `filterRules` stores a serialised `FilterRuleGroup` object,
 * so we need to safely narrow from `Prisma.JsonValue` to `FilterRuleGroup`
 * before passing it to `shouldAlert()`.
 */

import type { FilterRuleGroup } from '../lib/rules-engine';

/**
 * Minimal typed shape of a `NotificationPreference` row for use in the
 * watcher's alert-filtering path.  Using the full Prisma-generated type
 * requires importing the generated client which creates a circular build
 * dependency in test environments; this structural interface is sufficient.
 */
export interface NotificationPreferenceRow {
  id: string;
  userId: string;
  telegramEnabled: boolean;
  emailEnabled: boolean;
  whatsappEnabled: boolean;
  language: string;
  telegramChatId?: string | null;
  whatsappNumber?: string | null;
  /**
   * The user's custom alert-filter rules serialised as JSON.
   * `null` or `undefined` means "no filtering — alert on all payments".
   * Typed as `unknown` here and narrowed by `extractFilterRules()`.
   */
  filterRules?: unknown;
}

/**
 * Narrows the `filterRules` JSON column value to `FilterRuleGroup | null`.
 *
 * Returns `null` when:
 * - `prefs` is null/undefined (no preference row yet)
 * - `filterRules` is null/undefined (column not set)
 * - `filterRules` is not an object with a `rules` array (malformed data)
 *
 * A `null` return means the caller should treat the payment as matching
 * (alert on all payments — fail-open behaviour).
 */
export function extractFilterRules(
  prefs: NotificationPreferenceRow | null | undefined,
): FilterRuleGroup | null {
  if (!prefs) return null;

  const raw = prefs.filterRules;
  if (raw === null || raw === undefined) return null;

  // Must be a non-null object (not an array) with a `rules` array.
  if (
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !('rules' in raw) ||
    !Array.isArray((raw as Record<string, unknown>).rules)
  ) {
    return null;
  }

  // Safe to cast: we've verified the structural minimum that shouldAlert()
  // requires (object with a `rules` array).  The rules-engine evaluator
  // itself is defensive against individual rule shape issues.
  return raw as unknown as FilterRuleGroup;
}
