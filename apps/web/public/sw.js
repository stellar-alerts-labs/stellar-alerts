// Service Worker for Stellar Alerts PWA
// Implements offline-first caching strategy with background sync

const CACHE_VERSION = 'v1';
const CACHE_NAMES = {
  static: `${CACHE_VERSION}-static`,
  dynamic: `${CACHE_VERSION}-dynamic`,
  api: `${CACHE_VERSION}-api`,
};

// Assets to precache on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/favicon.ico',
];

/**
 * Install event - cache essential assets
 */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker');
  event.waitUntil(
    (async () => {
      try {
        const staticCache = await caches.open(CACHE_NAMES.static);
        await staticCache.addAll(PRECACHE_ASSETS);
        console.log('[SW] Precached essential assets');
      } catch (error) {
        console.error('[SW] Precache error:', error);
      }
      self.skipWaiting();
    })()
  );
});

/**
 * Activate event - clean up old caches
 */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker');
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      const isStaleCache = (name) =>
        !Object.values(CACHE_NAMES).includes(name);
      
      await Promise.all(
        cacheNames
          .filter(isStaleCache)
          .map((name) => {
            console.log(`[SW] Deleting old cache: ${name}`);
            return caches.delete(name);
          })
      );
      
      // Claim all clients after cleanup
      self.clients.claim();
      console.log('[SW] Activation complete');
    })()
  );
});

/**
 * Fetch event - implement caching strategies
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome extension requests
  if (url.protocol === 'chrome-extension:') {
    return;
  }

  // API requests: network-first, fallback to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstStrategy(request));
    return;
  }

  // Static assets: cache-first, fallback to network
  if (
    request.destination === 'style' ||
    request.destination === 'script' ||
    request.destination === 'font' ||
    request.destination === 'image'
  ) {
    event.respondWith(cacheFirstStrategy(request));
    return;
  }

  // HTML documents: network-first, fallback to cache
  if (request.destination === 'document') {
    event.respondWith(networkFirstStrategy(request));
    return;
  }

  // Default: network-first strategy
  event.respondWith(networkFirstStrategy(request));
});

/**
 * Network-first strategy: Try network first, fall back to cache
 */
async function networkFirstStrategy(request) {
  const cacheName = CACHE_NAMES.dynamic;
  
  try {
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Clone and cache successful responses
      const responseToCache = networkResponse.clone();
      const cache = await caches.open(cacheName);
      cache.put(request, responseToCache);
    }
    
    return networkResponse;
  } catch (error) {
    console.log(`[SW] Fetch failed for ${request.url}, trying cache`);
    const cachedResponse = await caches.match(request);
    
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Return offline page for document requests
    if (request.destination === 'document') {
      return caches.match('/offline.html') ||
        new Response('Offline - Page not available', { status: 503 });
    }
    
    return new Response('Offline - Resource not available', { status: 503 });
  }
}

/**
 * Cache-first strategy: Use cache, fall back to network
 */
async function cacheFirstStrategy(request) {
  const cacheName = CACHE_NAMES.static;
  
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }
  
  try {
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      const responseToCache = networkResponse.clone();
      const cache = await caches.open(cacheName);
      cache.put(request, responseToCache);
    }
    
    return networkResponse;
  } catch (error) {
    console.log(`[SW] Failed to fetch ${request.url}`);
    return new Response('Offline - Resource not available', { status: 503 });
  }
}

/**
 * Background Sync event for offline alert syncing
 */
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync event:', event.tag);
  
  if (event.tag === 'sync-alerts') {
    event.waitUntil(syncAlerts());
  } else if (event.tag === 'sync-watchers') {
    event.waitUntil(syncWatchers());
  }
});

/**
 * Sync alerts that were created while offline
 */
async function syncAlerts() {
  try {
    const db = await openDatabase();
    const pendingAlerts = await getAllFromStore(db, 'pending_alerts');
    
    console.log(`[SW] Syncing ${pendingAlerts.length} pending alerts`);
    
    for (const alert of pendingAlerts) {
      try {
        const response = await fetch('/api/alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alert.data),
        });
        
        if (response.ok) {
          await deleteFromStore(db, 'pending_alerts', alert.id);
          console.log(`[SW] Synced alert: ${alert.id}`);
        }
      } catch (error) {
        console.error(`[SW] Failed to sync alert ${alert.id}:`, error);
        throw error; // Rethrow to trigger retry
      }
    }
    
    console.log('[SW] Alert sync complete');
  } catch (error) {
    console.error('[SW] Alert sync failed:', error);
    throw error;
  }
}

/**
 * Sync watchers that were modified while offline
 */
async function syncWatchers() {
  try {
    const db = await openDatabase();
    const pendingWatchers = await getAllFromStore(db, 'pending_watchers');
    
    console.log(`[SW] Syncing ${pendingWatchers.length} pending watchers`);
    
    for (const watcher of pendingWatchers) {
      try {
        const { action, data, id } = watcher;
        let response;
        
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
        }
        
        if (response?.ok) {
          await deleteFromStore(db, 'pending_watchers', watcher.id);
          console.log(`[SW] Synced watcher: ${watcher.id}`);
        }
      } catch (error) {
        console.error(`[SW] Failed to sync watcher ${watcher.id}:`, error);
        throw error;
      }
    }
    
    console.log('[SW] Watcher sync complete');
  } catch (error) {
    console.error('[SW] Watcher sync failed:', error);
    throw error;
  }
}

/**
 * Open or create IndexedDB database
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('stellar-alerts-db', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains('pending_alerts')) {
        db.createObjectStore('pending_alerts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pending_watchers')) {
        db.createObjectStore('pending_watchers', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sync_log')) {
        const syncStore = db.createObjectStore('sync_log', { keyPath: 'id', autoIncrement: true });
        syncStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

/**
 * Get all records from an object store
 */
function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Delete a record from an object store
 */
function deleteFromStore(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Message event for client-server communication
 */
self.addEventListener('message', (event) => {
  const { type, payload } = event.data;
  
  console.log('[SW] Received message:', type);
  
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (type === 'CLEAR_CACHE') {
    clearAllCaches();
  } else if (type === 'SYNC_ALERTS') {
    event.waitUntil(syncAlerts());
  } else if (type === 'SYNC_WATCHERS') {
    event.waitUntil(syncWatchers());
  }
});

/**
 * Clear all caches
 */
async function clearAllCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map((name) => caches.delete(name)));
  console.log('[SW] All caches cleared');
}
