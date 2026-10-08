/**
 * Background Sync API integration for offline alert and watcher syncing
 * Handles registration and management of background sync tasks
 */

import {
  getPendingAlerts,
  getPendingWatchers,
  deletePendingAlert,
  deletePendingWatcher,
  incrementAlertRetries,
  incrementWatcherRetries,
  logSync,
} from './indexeddb';

const MAX_RETRIES = 3;
const SYNC_TAGS = {
  ALERTS: 'sync-alerts',
  WATCHERS: 'sync-watchers',
} as const;

interface BackgroundSyncManager {
  register(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}

type SyncCapableServiceWorkerRegistration = ServiceWorkerRegistration & {
  sync?: BackgroundSyncManager;
};

function getSyncManager(registration: ServiceWorkerRegistration) {
  return (registration as SyncCapableServiceWorkerRegistration).sync;
}

/**
 * Register background sync for alerts
 */
export async function registerAlertSync(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
    console.warn('[BackgroundSync] Background Sync API not supported');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const syncManager = getSyncManager(registration);
    if (!syncManager) {
      console.warn('[BackgroundSync] Sync manager not available');
      return;
    }

    await syncManager.register(SYNC_TAGS.ALERTS);
    console.log('[BackgroundSync] Registered alert sync task');
  } catch (error) {
    console.error('[BackgroundSync] Failed to register alert sync:', error);
  }
}

/**
 * Register background sync for watchers
 */
export async function registerWatcherSync(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
    console.warn('[BackgroundSync] Background Sync API not supported');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const syncManager = getSyncManager(registration);
    if (!syncManager) {
      console.warn('[BackgroundSync] Sync manager not available');
      return;
    }

    await syncManager.register(SYNC_TAGS.WATCHERS);
    console.log('[BackgroundSync] Registered watcher sync task');
  } catch (error) {
    console.error('[BackgroundSync] Failed to register watcher sync:', error);
  }
}

/**
 * Manually trigger alert sync
 */
export async function syncAlertsManual(): Promise<void> {
  const alerts = await getPendingAlerts();
  
  if (alerts.length === 0) {
    console.log('[BackgroundSync] No alerts to sync');
    return;
  }

  console.log(`[BackgroundSync] Starting manual sync for ${alerts.length} alerts`);

  for (const alert of alerts) {
    if (alert.retries >= MAX_RETRIES) {
      console.warn(`[BackgroundSync] Alert ${alert.id} exceeded max retries`);
      await logSync('alert', 'failed', `Exceeded max retries (${MAX_RETRIES})`);
      continue;
    }

    try {
      const response = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert.data),
      });

      if (response.ok) {
        await deletePendingAlert(alert.id);
        await logSync('alert', 'success', 'Successfully synced alert', alert.id);
        console.log(`[BackgroundSync] Synced alert: ${alert.id}`);
      } else {
        await incrementAlertRetries(alert.id);
        await logSync('alert', 'failed', `HTTP ${response.status}`, alert.id);
        console.warn(`[BackgroundSync] Failed to sync alert ${alert.id}: HTTP ${response.status}`);
      }
    } catch (error) {
      await incrementAlertRetries(alert.id);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await logSync('alert', 'failed', errorMsg, alert.id);
      console.error(`[BackgroundSync] Error syncing alert ${alert.id}:`, error);
    }
  }
}

/**
 * Manually trigger watcher sync
 */
export async function syncWatchersManual(): Promise<void> {
  const watchers = await getPendingWatchers();
  
  if (watchers.length === 0) {
    console.log('[BackgroundSync] No watchers to sync');
    return;
  }

  console.log(`[BackgroundSync] Starting manual sync for ${watchers.length} watchers`);

  for (const watcher of watchers) {
    if (watcher.retries >= MAX_RETRIES) {
      console.warn(`[BackgroundSync] Watcher ${watcher.id} exceeded max retries`);
      await logSync('watcher', 'failed', `Exceeded max retries (${MAX_RETRIES})`);
      continue;
    }

    try {
      let response: Response;
      const { action, data, id } = watcher;

      if (action === 'create') {
        response = await fetch('/api/watchers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
      } else if (action === 'update') {
        response = await fetch(`/api/watchers/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
      } else if (action === 'delete') {
        response = await fetch(`/api/watchers/${id}`, {
          method: 'DELETE',
        });
      } else {
        throw new Error(`Unknown action: ${action}`);
      }

      if (response.ok) {
        await deletePendingWatcher(watcher.id);
        await logSync('watcher', 'success', `${action} synced`, watcher.id);
        console.log(`[BackgroundSync] Synced watcher: ${watcher.id} (${action})`);
      } else {
        await incrementWatcherRetries(watcher.id);
        await logSync('watcher', 'failed', `HTTP ${response.status}`, watcher.id);
        console.warn(`[BackgroundSync] Failed to sync watcher ${watcher.id}: HTTP ${response.status}`);
      }
    } catch (error) {
      await incrementWatcherRetries(watcher.id);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await logSync('watcher', 'failed', errorMsg, watcher.id);
      console.error(`[BackgroundSync] Error syncing watcher ${watcher.id}:`, error);
    }
  }
}

/**
 * Request periodic background sync (if supported)
 */
export async function requestPeriodicSync(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PeriodicSyncManager' in window)) {
    console.warn('[BackgroundSync] Periodic Sync API not supported');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const periodicSyncManager = (registration as any).periodicSync;
    
    if (!periodicSyncManager) {
      console.warn('[BackgroundSync] Periodic Sync manager not available');
      return false;
    }

    // Request periodic sync every 24 hours (minimum recommended)
    await periodicSyncManager.register('sync-periodic', {
      minInterval: 24 * 60 * 60 * 1000,
    });

    console.log('[BackgroundSync] Registered periodic sync task');
    return true;
  } catch (error) {
    console.error('[BackgroundSync] Failed to register periodic sync:', error);
    return false;
  }
}

/**
 * Get list of registered sync tasks
 */
export async function getRegisteredSyncTags(): Promise<string[]> {
  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
    return [];
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const syncManager = getSyncManager(registration);
    if (!syncManager) {
      return [];
    }

    return await syncManager.getTags();
  } catch (error) {
    console.error('[BackgroundSync] Failed to get sync tags:', error);
    return [];
  }
}

/**
 * Unregister a specific sync task
 */
export async function unregisterSync(tag: string): Promise<void> {
  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    if (!getSyncManager(registration)) {
      return;
    }

    // SyncManager doesn't have unregister, but we can clear via service worker message
    if (registration.active) {
      registration.active.postMessage({
        type: 'CLEAR_SYNC_TAG',
        tag,
      });
    }

    console.log(`[BackgroundSync] Cleared sync tag: ${tag}`);
  } catch (error) {
    console.error(`[BackgroundSync] Failed to unregister sync tag ${tag}:`, error);
  }
}

/**
 * Check if background sync is supported
 */
export function isBackgroundSyncSupported(): boolean {
  return 'serviceWorker' in navigator && 'SyncManager' in window;
}

/**
 * Check if periodic background sync is supported
 */
export function isPeriodicSyncSupported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PeriodicSyncManager' in window &&
    'permissions' in navigator
  );
}

/**
 * Request notification permission for sync notifications
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) {
    console.warn('[BackgroundSync] Notifications API not supported');
    return 'denied';
  }

  if (Notification.permission !== 'default') {
    return Notification.permission;
  }

  try {
    const permission = await Notification.requestPermission();
    console.log(`[BackgroundSync] Notification permission: ${permission}`);
    return permission;
  } catch (error) {
    console.error('[BackgroundSync] Failed to request notification permission:', error);
    return 'denied';
  }
}

/**
 * Show sync notification
 */
export async function showSyncNotification(
  title: string,
  options?: NotificationOptions
): Promise<void> {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    console.warn('[BackgroundSync] Cannot show notification');
    return;
  }

  if (Notification.permission !== 'granted') {
    console.log('[BackgroundSync] Notification permission not granted');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    registration.showNotification(title, {
      icon: '/icon-192x192.png',
      badge: '/icon-192x192.png',
      ...options,
    });
  } catch (error) {
    console.error('[BackgroundSync] Failed to show notification:', error);
  }
}
