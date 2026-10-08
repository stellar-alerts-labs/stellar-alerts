/**
 * Hook for service worker registration and lifecycle management
 * Handles PWA installation, updates, and offline state
 */

'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import {
  registerAlertSync,
  registerWatcherSync,
  syncAlertsManual,
  syncWatchersManual,
} from '@/lib/backgroundSync';

export interface ServiceWorkerStatus {
  isSupported: boolean;
  isRegistered: boolean;
  hasUpdate: boolean;
  isOnline: boolean;
  registrationError: Error | null;
  registration: ServiceWorkerRegistration | null;
  skipWaiting: () => void;
  triggerManualSync: () => Promise<void>;
}

const MANIFEST_LINK_ID = 'manifest-link';

let swRegistration: ServiceWorkerRegistration | null = null;

/**
 * Initialize service worker registration
 */
async function initializeServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.warn('[SW] Service Worker API not supported');
    return null;
  }

  try {
    // Ensure manifest is linked
    ensureManifestLink();

    console.log('[SW] Registering service worker...');
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });

    console.log('[SW] Service Worker registered successfully');
    swRegistration = registration;

    // Handle controller change (when SW activates)
    navigator.serviceWorker.controller?.addEventListener('controllerchange', () => {
      console.log('[SW] Controller changed - page refresh recommended');
      // Don't auto-reload; let the user decide via update notification
    });

    return registration;
  } catch (error) {
    console.error('[SW] Service Worker registration failed:', error);
    throw error;
  }
}

/**
 * Ensure manifest.json is linked in the document
 */
function ensureManifestLink(): void {
  let manifestLink = document.getElementById(MANIFEST_LINK_ID) as HTMLLinkElement | null;
  
  if (!manifestLink) {
    manifestLink = document.createElement('link');
    manifestLink.id = MANIFEST_LINK_ID;
    manifestLink.rel = 'manifest';
    manifestLink.href = '/manifest.json';
    document.head.appendChild(manifestLink);
    console.log('[SW] Added manifest link to document head');
  }
}

/**
 * Hook for service worker registration and management
 */
export function useServiceWorker(): ServiceWorkerStatus {
  const [isSupported] = useState(() => 'serviceWorker' in navigator);
  const [isRegistered, setIsRegistered] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [registrationError, setRegistrationError] = useState<Error | null>(null);
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof window !== 'undefined') {
      return navigator.onLine;
    }
    return true;
  });

  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  const skipWaiting = useCallback(() => {
    if (!registrationRef.current?.waiting) return;

    registrationRef.current.waiting.postMessage({ type: 'SKIP_WAITING' });
    setHasUpdate(false);

    setTimeout(() => {
      window.location.reload();
    }, 500);
  }, []);

  const triggerSync = useCallback(async () => {
    try {
      console.log('[SW] Triggering manual sync...');
      await Promise.all([syncAlertsManual(), syncWatchersManual()]);
      console.log('[SW] Manual sync completed');
    } catch (error) {
      console.error('[SW] Manual sync failed:', error);
    }
  }, []);

  /**
   * Handle online/offline state
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      console.log('[SW] App came online');
      setIsOnline(true);
      triggerSync();
    };

    const handleOffline = () => {
      console.log('[SW] App went offline');
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [triggerSync]);

  /**
   * Register service worker on mount
   */
  useEffect(() => {
    if (!isSupported) return;

    (async () => {
      try {
        const registration = await initializeServiceWorker();
        
        if (!registration) {
          setIsRegistered(false);
          return;
        }

        registrationRef.current = registration;
        setIsRegistered(true);

        // Check for updates periodically
        const updateCheckInterval = setInterval(async () => {
          try {
            await registration.update();
            console.log('[SW] Checked for updates');
          } catch (error) {
            console.error('[SW] Update check failed:', error);
          }
        }, 60 * 1000); // Check every minute

        // Listen for updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[SW] New service worker available');
              setHasUpdate(true);

              // Notify user about update
              showUpdateNotification(() => {
                skipWaiting();
              });
            }
          });
        });

        // Register background sync tasks
        try {
          await registerAlertSync();
          await registerWatcherSync();
          console.log('[SW] Background sync tasks registered');
        } catch (error) {
          console.warn('[SW] Background sync registration failed:', error);
        }

        return () => {
          clearInterval(updateCheckInterval);
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('[SW] Initialization failed:', err);
        setRegistrationError(err);
      }
    })();
  }, [isSupported, skipWaiting]);

  return {
    isSupported,
    isRegistered,
    hasUpdate,
    isOnline,
    registrationError,
    registration: registrationRef.current,
    skipWaiting,
    triggerManualSync: triggerSync,
  };
}

/**
 * Show update notification to user
 */
function showUpdateNotification(onSkip: () => void): void {
  // Create and display an in-app notification
  // This can be customized based on your UI framework
  console.log('[SW] New update available - consider displaying notification');
  
  // For PWAs, you might use a toast or modal instead
  // Example with browser notification:
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const notification = new Notification('Stellar Alerts Update', {
        body: 'A new version is available. Click to update.',
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png',
        tag: 'app-update',
      });
      notification.onclick = () => {
        onSkip();
        notification.close();
      };
    } catch (error) {
      console.error('[SW] Failed to show notification:', error);
    }
  }
}

/**
 * Get the current service worker registration
 */
export function getServiceWorkerRegistration(): ServiceWorkerRegistration | null {
  return swRegistration;
}

/**
 * Manually check for service worker updates
 */
export async function checkForUpdates(): Promise<boolean> {
  if (!swRegistration) {
    console.warn('[SW] No active service worker registration');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistrations();
    for (const reg of registration) {
      await reg.update();
    }
    console.log('[SW] Checked for updates');
    return true;
  } catch (error) {
    console.error('[SW] Update check failed:', error);
    return false;
  }
}

/**
 * Unregister service worker (for cleanup/debugging)
 */
export async function unregisterServiceWorker(): Promise<boolean> {
  if (!swRegistration) {
    console.warn('[SW] No active service worker registration');
    return false;
  }

  try {
    const success = await swRegistration.unregister();
    if (success) {
      console.log('[SW] Service Worker unregistered');
      swRegistration = null;
    }
    return success;
  } catch (error) {
    console.error('[SW] Failed to unregister service worker:', error);
    return false;
  }
}

/**
 * Clear all service worker caches
 */
export async function clearServiceWorkerCaches(): Promise<void> {
  try {
    if (swRegistration?.active) {
      swRegistration.active.postMessage({ type: 'CLEAR_CACHE' });
    }
    console.log('[SW] Clearing caches via service worker');
  } catch (error) {
    console.error('[SW] Failed to clear caches:', error);
  }
}
