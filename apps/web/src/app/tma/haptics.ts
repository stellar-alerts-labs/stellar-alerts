'use client';

/**
 * Thin wrapper over the Telegram WebApp HapticFeedback API (#1006).
 *
 * Every call is a best-effort no-op outside a Telegram client (or when the
 * running client is too old to expose HapticFeedback), so callers can fire
 * haptics unconditionally without feature-detecting at each call site.
 *
 * See https://core.telegram.org/bots/webapps#hapticfeedback
 */

export type HapticImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
export type HapticNotificationType = 'error' | 'success' | 'warning';

interface TelegramHaptics {
  impactOccurred?: (style: HapticImpactStyle) => void;
  notificationOccurred?: (type: HapticNotificationType) => void;
  selectionChanged?: () => void;
}

function getHaptics(): TelegramHaptics | null {
  if (typeof window === 'undefined') return null;
  const haptic = (window as unknown as {
    Telegram?: { WebApp?: { HapticFeedback?: TelegramHaptics } };
  }).Telegram?.WebApp?.HapticFeedback;
  return haptic ?? null;
}

/** A physical impact of the given intensity (e.g. confirming a destructive tap). */
export function impact(style: HapticImpactStyle = 'medium'): void {
  try {
    getHaptics()?.impactOccurred?.(style);
  } catch {
    /* no-op outside Telegram */
  }
}

/** A task-outcome cue — success/warning/error after a route toggle or save. */
export function notify(type: HapticNotificationType): void {
  try {
    getHaptics()?.notificationOccurred?.(type);
  } catch {
    /* no-op outside Telegram */
  }
}

/** A light tick as the selection/filter changes. */
export function selection(): void {
  try {
    getHaptics()?.selectionChanged?.();
  } catch {
    /* no-op outside Telegram */
  }
}
