/**
 * IndexedDB database layer for offline alert and watcher persistence
 * Handles all database operations for PWA offline functionality
 */

export interface PendingAlert {
  id: string;
  data: Record<string, any>;
  createdAt: number;
  synced: boolean;
  retries: number;
}

export interface PendingWatcher {
  id: string;
  action: 'create' | 'update' | 'delete';
  data: Record<string, any>;
  createdAt: number;
  synced: boolean;
  retries: number;
}

export interface SyncLogEntry {
  id?: number;
  timestamp: number;
  type: 'alert' | 'watcher';
  status: 'pending' | 'success' | 'failed';
  message?: string;
  itemId?: string;
}

export interface CachedResponse {
  id: string;
  url: string;
  response: string; // JSON stringified
  timestamp: number;
  ttl?: number; // Time to live in milliseconds
}

const DB_NAME = 'stellar-alerts-db';
const DB_VERSION = 1;

// Object store names
export const STORES = {
  PENDING_ALERTS: 'pending_alerts',
  PENDING_WATCHERS: 'pending_watchers',
  SYNC_LOG: 'sync_log',
  CACHED_RESPONSES: 'cached_responses',
} as const;

let dbInstance: IDBDatabase | null = null;

/**
 * Initialize and get database instance
 */
export async function getDatabase(): Promise<IDBDatabase> {
  if (dbInstance) {
    return dbInstance;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[IndexedDB] Error opening database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      console.log('[IndexedDB] Database opened successfully');
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      initializeStores(db);
    };
  });
}

/**
 * Initialize object stores on database upgrade
 */
function initializeStores(db: IDBDatabase) {
  console.log('[IndexedDB] Initializing database schema');

  // Pending alerts store
  if (!db.objectStoreNames.contains(STORES.PENDING_ALERTS)) {
    const alertStore = db.createObjectStore(STORES.PENDING_ALERTS, { 
      keyPath: 'id' 
    });
    alertStore.createIndex('synced', 'synced', { unique: false });
    alertStore.createIndex('createdAt', 'createdAt', { unique: false });
    console.log('[IndexedDB] Created pending_alerts store');
  }

  // Pending watchers store
  if (!db.objectStoreNames.contains(STORES.PENDING_WATCHERS)) {
    const watcherStore = db.createObjectStore(STORES.PENDING_WATCHERS, { 
      keyPath: 'id' 
    });
    watcherStore.createIndex('synced', 'synced', { unique: false });
    watcherStore.createIndex('action', 'action', { unique: false });
    console.log('[IndexedDB] Created pending_watchers store');
  }

  // Sync log store
  if (!db.objectStoreNames.contains(STORES.SYNC_LOG)) {
    const syncStore = db.createObjectStore(STORES.SYNC_LOG, { 
      keyPath: 'id', 
      autoIncrement: true 
    });
    syncStore.createIndex('timestamp', 'timestamp', { unique: false });
    syncStore.createIndex('type', 'type', { unique: false });
    syncStore.createIndex('status', 'status', { unique: false });
    console.log('[IndexedDB] Created sync_log store');
  }

  // Cached responses store
  if (!db.objectStoreNames.contains(STORES.CACHED_RESPONSES)) {
    const cacheStore = db.createObjectStore(STORES.CACHED_RESPONSES, { 
      keyPath: 'id' 
    });
    cacheStore.createIndex('url', 'url', { unique: false });
    cacheStore.createIndex('timestamp', 'timestamp', { unique: false });
    console.log('[IndexedDB] Created cached_responses store');
  }
}

/**
 * Add a pending alert to the database
 */
export async function addPendingAlert(
  data: Record<string, any>
): Promise<PendingAlert> {
  const db = await getDatabase();
  const alert: PendingAlert = {
    id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    data,
    createdAt: Date.now(),
    synced: false,
    retries: 0,
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PENDING_ALERTS], 'readwrite');
    const store = transaction.objectStore(STORES.PENDING_ALERTS);
    const request = store.add(alert);

    request.onerror = () => {
      console.error('[IndexedDB] Error adding pending alert:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log(`[IndexedDB] Added pending alert: ${alert.id}`);
      logSync('alert', 'pending', `Created pending alert: ${alert.id}`);
      resolve(alert);
    };
  });
}

/**
 * Add a pending watcher action to the database
 */
export async function addPendingWatcher(
  action: 'create' | 'update' | 'delete',
  data: Record<string, any>,
  id?: string
): Promise<PendingWatcher> {
  const db = await getDatabase();
  const watcher: PendingWatcher = {
    id: id || `watcher_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    action,
    data,
    createdAt: Date.now(),
    synced: false,
    retries: 0,
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PENDING_WATCHERS], 'readwrite');
    const store = transaction.objectStore(STORES.PENDING_WATCHERS);
    const request = store.add(watcher);

    request.onerror = () => {
      console.error('[IndexedDB] Error adding pending watcher:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log(`[IndexedDB] Added pending watcher: ${watcher.id} (${action})`);
      logSync('watcher', 'pending', `Created pending ${action} for watcher: ${watcher.id}`);
      resolve(watcher);
    };
  });
}

/**
 * Get all pending alerts
 */
export async function getPendingAlerts(): Promise<PendingAlert[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PENDING_ALERTS], 'readonly');
    const store = transaction.objectStore(STORES.PENDING_ALERTS);
    const request = store.getAll();

    request.onerror = () => {
      console.error('[IndexedDB] Error fetching pending alerts:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      const alerts = request.result as PendingAlert[];
      console.log(`[IndexedDB] Retrieved ${alerts.length} pending alerts`);
      resolve(alerts);
    };
  });
}

/**
 * Get all pending watchers
 */
export async function getPendingWatchers(): Promise<PendingWatcher[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PENDING_WATCHERS], 'readonly');
    const store = transaction.objectStore(STORES.PENDING_WATCHERS);
    const request = store.getAll();

    request.onerror = () => {
      console.error('[IndexedDB] Error fetching pending watchers:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      const watchers = request.result as PendingWatcher[];
      console.log(`[IndexedDB] Retrieved ${watchers.length} pending watchers`);
      resolve(watchers);
    };
  });
}

/**
 * Delete a pending alert after successful sync
 */
export async function deletePendingAlert(id: string): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PENDING_ALERTS], 'readwrite');
    const store = transaction.objectStore(STORES.PENDING_ALERTS);
    const request = store.delete(id);

    request.onerror = () => {
      console.error('[IndexedDB] Error deleting pending alert:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log(`[IndexedDB] Deleted pending alert: ${id}`);
      resolve();
    };
  });
}

/**
 * Delete a pending watcher after successful sync
 */
export async function deletePendingWatcher(id: string): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PENDING_WATCHERS], 'readwrite');
    const store = transaction.objectStore(STORES.PENDING_WATCHERS);
    const request = store.delete(id);

    request.onerror = () => {
      console.error('[IndexedDB] Error deleting pending watcher:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log(`[IndexedDB] Deleted pending watcher: ${id}`);
      resolve();
    };
  });
}

/**
 * Update retry count for a pending alert
 */
export async function incrementAlertRetries(id: string): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PENDING_ALERTS], 'readwrite');
    const store = transaction.objectStore(STORES.PENDING_ALERTS);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const alert = getRequest.result as PendingAlert;
      if (alert) {
        alert.retries += 1;
        const updateRequest = store.put(alert);
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = () => reject(updateRequest.error);
      } else {
        reject(new Error(`Alert ${id} not found`));
      }
    };

    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * Update retry count for a pending watcher
 */
export async function incrementWatcherRetries(id: string): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.PENDING_WATCHERS], 'readwrite');
    const store = transaction.objectStore(STORES.PENDING_WATCHERS);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const watcher = getRequest.result as PendingWatcher;
      if (watcher) {
        watcher.retries += 1;
        const updateRequest = store.put(watcher);
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = () => reject(updateRequest.error);
      } else {
        reject(new Error(`Watcher ${id} not found`));
      }
    };

    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * Log a sync event
 */
export async function logSync(
  type: 'alert' | 'watcher',
  status: 'pending' | 'success' | 'failed',
  message?: string,
  itemId?: string
): Promise<void> {
  const db = await getDatabase();
  const entry: SyncLogEntry = {
    timestamp: Date.now(),
    type,
    status,
    message,
    itemId,
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.SYNC_LOG], 'readwrite');
    const store = transaction.objectStore(STORES.SYNC_LOG);
    const request = store.add(entry);

    request.onerror = () => {
      console.error('[IndexedDB] Error logging sync event:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log(`[IndexedDB] Logged sync event: ${type} - ${status}`);
      resolve();
    };
  });
}

/**
 * Get sync history
 */
export async function getSyncHistory(limit: number = 50): Promise<SyncLogEntry[]> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.SYNC_LOG], 'readonly');
    const store = transaction.objectStore(STORES.SYNC_LOG);
    const index = store.index('timestamp');
    const request = index.openCursor(null, 'prev');
    
    const results: SyncLogEntry[] = [];
    let count = 0;

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (cursor && count < limit) {
        results.push(cursor.value);
        count++;
        cursor.continue();
      } else {
        resolve(results);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Cache an API response
 */
export async function cacheResponse(
  url: string,
  response: any,
  ttl?: number
): Promise<void> {
  const db = await getDatabase();
  const cacheEntry: CachedResponse = {
    id: `cache_${url}_${Date.now()}`,
    url,
    response: JSON.stringify(response),
    timestamp: Date.now(),
    ttl,
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.CACHED_RESPONSES], 'readwrite');
    const store = transaction.objectStore(STORES.CACHED_RESPONSES);
    const request = store.put(cacheEntry);

    request.onerror = () => {
      console.error('[IndexedDB] Error caching response:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log(`[IndexedDB] Cached response for URL: ${url}`);
      resolve();
    };
  });
}

/**
 * Get cached response by URL
 */
export async function getCachedResponse(url: string): Promise<any | null> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.CACHED_RESPONSES], 'readonly');
    const store = transaction.objectStore(STORES.CACHED_RESPONSES);
    const index = store.index('url');
    const request = index.getAll(url);

    request.onerror = () => {
      console.error('[IndexedDB] Error retrieving cached response:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      const results = request.result as CachedResponse[];
      if (results.length === 0) {
        resolve(null);
        return;
      }

      // Get the most recent cache entry
      const latest = results.sort((a, b) => b.timestamp - a.timestamp)[0];
      
      // Check if cache has expired
      if (latest.ttl && Date.now() - latest.timestamp > latest.ttl) {
        console.log(`[IndexedDB] Cache expired for URL: ${url}`);
        resolve(null);
        return;
      }

      try {
        const parsed = JSON.parse(latest.response);
        console.log(`[IndexedDB] Retrieved cached response for URL: ${url}`);
        resolve(parsed);
      } catch (error) {
        console.error('[IndexedDB] Error parsing cached response:', error);
        resolve(null);
      }
    };
  });
}

/**
 * Clear all cached responses
 */
export async function clearCachedResponses(): Promise<void> {
  const db = await getDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORES.CACHED_RESPONSES], 'readwrite');
    const store = transaction.objectStore(STORES.CACHED_RESPONSES);
    const request = store.clear();

    request.onerror = () => {
      console.error('[IndexedDB] Error clearing cache:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log('[IndexedDB] Cleared all cached responses');
      resolve();
    };
  });
}

/**
 * Clear all offline data
 */
export async function clearAllOfflineData(): Promise<void> {
  const db = await getDatabase();
  const stores = [
    STORES.PENDING_ALERTS,
    STORES.PENDING_WATCHERS,
    STORES.CACHED_RESPONSES,
  ];

  const promises = stores.map((storeName) => {
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  });

  await Promise.all(promises);
  console.log('[IndexedDB] Cleared all offline data');
}

/**
 * Get database statistics
 */
export async function getDatabaseStats(): Promise<{
  pendingAlerts: number;
  pendingWatchers: number;
  cachedResponses: number;
  syncLogEntries: number;
}> {
  const db = await getDatabase();

  const getCount = (storeName: string): Promise<number> => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.count();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  };

  const [pendingAlerts, pendingWatchers, cachedResponses, syncLogEntries] = 
    await Promise.all([
      getCount(STORES.PENDING_ALERTS),
      getCount(STORES.PENDING_WATCHERS),
      getCount(STORES.CACHED_RESPONSES),
      getCount(STORES.SYNC_LOG),
    ]);

  return {
    pendingAlerts,
    pendingWatchers,
    cachedResponses,
    syncLogEntries,
  };
}
