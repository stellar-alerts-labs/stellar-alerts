# Offline PWA Mode - Documentation

## Overview

Stellar Alerts now includes comprehensive Progressive Web App (PWA) capabilities with offline support, background synchronization, and IndexedDB caching. This allows users to continue managing alerts and watchers even when their connection is interrupted.

## Features

### 1. Service Worker Caching Strategy

The service worker implements a dual caching strategy:

**Network-First Strategy**
- Used for API endpoints and HTML documents
- Attempts to fetch from the network first
- Falls back to cached content if network unavailable
- Caches successful responses for offline access
- Provides automatic offline page fallback

**Cache-First Strategy**
- Used for static assets (CSS, JS, fonts, images)
- Serves from cache immediately
- Updates cache with newer versions from network
- Ensures instant load times
- Reduces bandwidth usage

### 2. IndexedDB Offline Storage

Persistent offline data storage with automatic synchronization:

**Pending Alerts Store**
- Stores alerts created while offline
- Tracks retry attempts and sync status
- Indexed by sync status and creation time
- Automatically synced when reconnected

**Pending Watchers Store**
- Stores watcher CRUD operations (create, update, delete)
- Tracks action type and retry count
- Maintains operation order for consistency
- Batch syncs on reconnection

**Sync Log Store**
- Records all synchronization events
- Tracks success, failure, and pending statuses
- Maintains timestamp and error messages
- Useful for debugging and user information

**Cached Responses Store**
- Caches API responses with optional TTL
- Supports response expiration
- Reduces redundant network requests
- Falls back during offline periods

### 3. Background Sync API

Automatic synchronization of pending changes:

**Background Sync Features**
- Registers sync tasks in service worker
- Triggers automatic sync when connection restored
- Handles retry logic with exponential backoff
- Max 3 retry attempts per item
- Incremental sync to avoid duplicate sends

**Supported Operations**
- Alert creation sync
- Watcher creation/update/delete sync
- Automatic cleanup after successful sync
- Error logging and recovery

### 4. Service Worker Registration Hook

React hook for managing service worker lifecycle:

**Hook API**
```typescript
const {
  isSupported,        // Boolean: ServiceWorker API available
  isRegistered,       // Boolean: SW currently registered
  hasUpdate,          // Boolean: New SW version available
  isOnline,           // Boolean: Network connection status
  registrationError,  // Error | null: Registration errors
  registration,       // ServiceWorkerRegistration | null
  skipWaiting,        // Function: Activate waiting SW
  triggerManualSync,  // Function: Manually sync pending items
} = useServiceWorker();
```

**Features**
- Automatic registration on component mount
- Update detection with notification
- Manual sync triggering
- Online/offline state tracking
- Error handling and recovery

### 5. Offline UI

**Offline Recovery Banner**
- Visual indicator of connection status
- Shows disconnection timestamp
- Manual retry button
- Auto-hides when reconnected
- Success notification on restoration

**Offline Fallback Page**
- Displayed when network document fetch fails
- Shows offline status with animated indicator
- Provides retry connection button
- Displays offline mode features
- Auto-detects when connection returns

## Usage Guide

### Basic Setup

1. **Service Worker Registration**
   The `useServiceWorker` hook handles registration automatically:

   ```typescript
   import { useServiceWorker } from '@/hooks/useServiceWorker';

   export function App() {
     const { isOnline, hasUpdate, skipWaiting } = useServiceWorker();

     return (
       <>
         {hasUpdate && (
           <UpdateNotification onUpdate={skipWaiting} />
         )}
         {!isOnline && <OfflineNotice />}
       </>
     );
   }
   ```

2. **Using IndexedDB for Offline Data**
   ```typescript
   import {
     addPendingAlert,
     getPendingAlerts,
     addPendingWatcher,
   } from '@/lib/indexeddb';

   // Store alert while offline
   async function createAlertOffline(data) {
     const alert = await addPendingAlert(data);
     console.log('Alert stored for sync:', alert.id);
   }

   // Retrieve pending items
   async function viewPendingAlerts() {
     const alerts = await getPendingAlerts();
     return alerts;
   }
   ```

3. **Manual Sync Triggering**
   ```typescript
   import { syncAlertsManual, syncWatchersManual } from '@/lib/backgroundSync';

   async function manualSync() {
     try {
       await syncAlertsManual();
       await syncWatchersManual();
       console.log('Manual sync completed');
     } catch (error) {
       console.error('Sync failed:', error);
     }
   }
   ```

### Handling Offline States

**Network Status Monitoring**
```typescript
import { useNetworkStatus } from '@/hooks/useNetworkStatus';

export function MyComponent() {
  const { isOnline, offlineSince, retry } = useNetworkStatus();

  if (!isOnline) {
    return (
      <div>
        Offline since {offlineSince?.toLocaleTimeString()}
        <button onClick={() => retry()}>Retry Connection</button>
      </div>
    );
  }

  return <div>Online and syncing...</div>;
}
```

**Automatic Sync on Reconnection**
The service worker automatically:
1. Detects when connection returns (online event)
2. Registers background sync tasks
3. Syncs all pending alerts and watchers
4. Logs sync results to IndexedDB
5. Notifies user of sync completion

## API Reference

### IndexedDB Functions

#### `getDatabase(): Promise<IDBDatabase>`
Opens or creates the application database.

#### `addPendingAlert(data): Promise<PendingAlert>`
Creates and stores a pending alert for offline sync.

#### `addPendingWatcher(action, data, id?): Promise<PendingWatcher>`
Creates a pending watcher action (create/update/delete).

#### `getPendingAlerts(): Promise<PendingAlert[]>`
Retrieves all pending alerts.

#### `getPendingWatchers(): Promise<PendingWatcher[]>`
Retrieves all pending watcher operations.

#### `deletePendingAlert(id): Promise<void>`
Removes a synced alert from pending storage.

#### `deletePendingWatcher(id): Promise<void>`
Removes a synced watcher from pending storage.

#### `logSync(type, status, message?, itemId?): Promise<void>`
Records a synchronization event.

#### `getSyncHistory(limit?): Promise<SyncLogEntry[]>`
Retrieves sync event history (default: 50 most recent).

#### `cacheResponse(url, response, ttl?): Promise<void>`
Caches an API response with optional expiration.

#### `getCachedResponse(url): Promise<any | null>`
Retrieves a cached response, checking expiration.

#### `getDatabaseStats(): Promise<Stats>`
Returns database statistics (pending items, cache size, etc.).

### Background Sync Functions

#### `registerAlertSync(): Promise<void>`
Registers background sync for pending alerts.

#### `registerWatcherSync(): Promise<void>`
Registers background sync for pending watchers.

#### `syncAlertsManual(): Promise<void>`
Manually triggers alert synchronization.

#### `syncWatchersManual(): Promise<void>`
Manually triggers watcher synchronization.

#### `isBackgroundSyncSupported(): boolean`
Checks if Background Sync API is available.

#### `isPeriodicSyncSupported(): boolean`
Checks if Periodic Sync API is available.

#### `requestNotificationPermission(): Promise<NotificationPermission>`
Requests browser notification permissions.

#### `showSyncNotification(title, options?): Promise<void>`
Shows a sync notification to the user.

### Service Worker Hook

#### `useServiceWorker(): ServiceWorkerStatus`
React hook for service worker management.

**Returns:**
```typescript
interface ServiceWorkerStatus {
  isSupported: boolean;
  isRegistered: boolean;
  hasUpdate: boolean;
  isOnline: boolean;
  registrationError: Error | null;
  registration: ServiceWorkerRegistration | null;
  skipWaiting: () => void;
  triggerManualSync: () => Promise<void>;
}
```

## Caching Strategies

### Cache Names
- `v1-static`: Static assets (CSS, JS, fonts, images)
- `v1-dynamic`: Dynamic content (HTML documents)
- `v1-api`: API responses

### Cache Invalidation
1. **Service Worker Update**
   - Old cache versions are automatically cleaned on SW activation
   - Cache busting through version prefix (`v1-`, `v2-`, etc.)

2. **API Responses**
   - API responses cached but marked for network-first retrieval
   - Ensures fresh data when online

3. **Static Assets**
   - Cache-first strategy with unlimited cache duration
   - Manual update trigger via `skipWaiting()`

## Sync Retry Logic

**Retry Configuration**
- Maximum retries: 3 attempts per item
- Exponential backoff: Built-in service worker retry mechanism
- Automatic retry on background sync registration

**Failure Handling**
1. First attempt fails → Increment retry counter
2. Retry 1-2 fail → Continue retrying
3. Retry 3 fails → Mark as failed, log error
4. User can manually trigger sync to retry

**Success Handling**
- Successful sync removes item from pending store
- Sync event logged with success status
- No duplicate syncs

## Testing

### Running Tests

```bash
# Test IndexedDB layer
npm run test src/lib/indexeddb.test.ts

# Test Background Sync
npm run test src/lib/backgroundSync.test.ts

# Test Service Worker Hook
npm run test src/hooks/useServiceWorker.test.ts

# Run all PWA tests
npm run test -- --grep "PWA|IndexedDB|Background|Service"
```

### Test Coverage

- **IndexedDB**: Database initialization, CRUD operations, caching, statistics
- **Background Sync**: Registration, retry logic, error handling, notifications
- **Service Worker Hook**: Lifecycle, updates, sync triggers, state management

## Browser Compatibility

### Required APIs
- **Service Worker API**: Chrome 40+, Firefox 44+, Edge 17+, Safari 11.1+
- **IndexedDB**: Chrome 13+, Firefox 10+, Edge (all), Safari 10+
- **Background Sync API**: Chrome 49+, Edge 79+ (Firefox and Safari: no native support)
- **Notification API**: Chrome 22+, Firefox 22+, Edge (all), Safari 16+
- **Periodic Sync API**: Chrome 80+, Edge 79+ (Firefox and Safari: no native support)

### Graceful Degradation
- PWA features are optional and don't break core functionality
- App works fully online without service worker
- Offline features gracefully disabled if APIs unavailable
- No console errors on unsupported browsers

## Performance Considerations

### Caching Impact
- **Static Assets**: Instant load times on repeat visits
- **API Responses**: Reduced server load and bandwidth
- **Service Worker**: ~5MB cache allocation (varies by browser)

### IndexedDB Storage
- **Default Quota**: 50MB (varies by browser)
- **Cleanup**: Manual via `clearAllOfflineData()`
- **Monitoring**: Check stats via `getDatabaseStats()`

### Network Strategy
- Network-first for docs: ~100ms overhead on first load
- Cache-first for assets: Instant (~10ms) from cache
- Automatic fallback: <500ms to offline page

## Troubleshooting

### Service Worker Not Registering
1. Check browser console for errors
2. Verify `/sw.js` is accessible
3. Check `Service-Worker-Allowed` header
4. Ensure HTTPS (or localhost for development)

### Offline Sync Not Working
1. Verify Background Sync API support
2. Check IndexedDB has data via `getDatabaseStats()`
3. Manually trigger sync: `triggerManualSync()`
4. Check sync history: `getSyncHistory()`

### Cache Growing Too Large
1. Clear cache: `clearServiceWorkerCaches()`
2. Clear offline data: `clearAllOfflineData()`
3. Monitor with: `getDatabaseStats()`

### Update Not Installing
1. Check `hasUpdate` flag in hook
2. Manually trigger: `skipWaiting()`
3. Check browser cache control headers
4. Clear browser cache and reload

## Future Enhancements

- Sync notification preferences
- Custom sync retry strategies
- Offline data encryption
- Selective cache pruning
- Analytics for offline usage
- Sync conflict resolution UI

## Related Files

- `/public/sw.js` - Service Worker implementation
- `/public/manifest.json` - PWA manifest
- `/public/offline.html` - Offline fallback page
- `/src/lib/indexeddb.ts` - IndexedDB layer
- `/src/lib/backgroundSync.ts` - Background Sync handler
- `/src/hooks/useServiceWorker.ts` - SW registration hook
- `/src/hooks/useNetworkStatus.ts` - Network status monitoring
- `/src/components/OfflineRecoveryBanner.tsx` - Offline UI component
- `/next.config.ts` - PWA configuration

## Support

For issues or questions about PWA functionality:
1. Check browser DevTools (Application > Service Workers)
2. Review sync history in IndexedDB
3. Check `offline.html` for network issues
4. Enable debug logging in service worker
