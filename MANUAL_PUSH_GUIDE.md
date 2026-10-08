# Manual Git Push Guide

Since the automated git commands are experiencing timeout issues, please follow these manual steps:

## Step 1: Open Command Prompt or PowerShell

Open Windows PowerShell or Command Prompt and navigate to the repository:

```powershell
cd "C:\Users\LENOVO PC\Desktop\New folder (3)\stellar-alerts"
```

## Step 2: Verify the Branch

Check that you're on the correct feature branch:

```powershell
git branch
git branch -v
```

You should see `feat/offline-pwa-mode` as the current branch.

## Step 3: Check Current Status

```powershell
git status
```

This should show either:
- Files staged for commit, or
- A message indicating the branch is ready to push

## Step 4: View Changes

```powershell
git log --oneline -5
```

This shows the last 5 commits. You should see your PWA commit near the top.

## Step 5: Push to GitHub

```powershell
git push -u origin feat/offline-pwa-mode
```

This will:
- Push your feature branch to GitHub
- Set upstream tracking
- Create the branch on GitHub if it doesn't exist

**This may take a minute or two.** Please wait for it to complete.

## Step 6: Verify Push Success

After the push completes, you should see output like:

```
Total 25 (delta 12), reused 0 (delta 0), pack-reused 0
To github.com:Esbeevybz/stellar-alerts.git
 * [new branch]      feat/offline-pwa-mode -> feat/offline-pwa-mode
Branch 'feat/offline-pwa-mode' set up to track remote 'origin/feat/offline-pwa-mode'.
```

## Step 7: Create Pull Request on GitHub

Once the push succeeds:

1. Go to: **https://github.com/Esbeevybz/stellar-alerts**

2. You should see a notification banner saying:
   > "feat/offline-pwa-mode had recent pushes X minutes ago"
   > **[Compare & pull request]** button

3. Click the **"Compare & pull request"** button

4. Fill in the PR details:

   **Title:**
   ```
   feat: implement offline PWA mode with background sync and IndexedDB cache
   ```

   **Description:**
   ```markdown
   ## Overview
   Implements comprehensive Progressive Web App (PWA) support for Stellar Alerts with offline functionality.

   ## Changes
   - Service Worker with network-first/cache-first caching strategies
   - IndexedDB layer for offline alert and watcher persistence
   - Background Sync API integration for automatic sync on reconnection
   - React hook for Service Worker lifecycle management
   - Elegant offline fallback UI with auto-reconnect detection
   - Comprehensive tests for all PWA features

   ## Implementation Details

   ### Files Added (11 total):
   - `apps/web/public/manifest.json` - PWA web manifest
   - `apps/web/public/sw.js` - Service Worker
   - `apps/web/public/offline.html` - Offline fallback page
   - `apps/web/src/lib/indexeddb.ts` - IndexedDB persistence layer
   - `apps/web/src/lib/indexeddb.test.ts` - IndexedDB tests
   - `apps/web/src/lib/backgroundSync.ts` - Background Sync handler
   - `apps/web/src/lib/backgroundSync.test.ts` - Sync tests
   - `apps/web/src/hooks/useServiceWorker.ts` - SW registration hook
   - `apps/web/src/hooks/useServiceWorker.test.ts` - Hook tests
   - `apps/web/PWA_DOCUMENTATION.md` - Complete documentation
   - `apps/web/next.config.ts` - Updated PWA configuration

   ## Features

   ### Service Worker
   - Network-first strategy for API endpoints and documents
   - Cache-first strategy for static assets
   - Automatic cache cleanup on update

   ### Offline Storage
   - Pending alerts with sync tracking
   - Watcher CRUD operations persistence
   - Sync event logging
   - API response caching with TTL

   ### Background Sync
   - Automatic sync on connection restoration
   - Manual sync triggering
   - Retry logic (max 3 attempts per item)
   - Notification support

   ### User Experience
   - Offline recovery banner
   - Elegant offline page with auto-reconnect
   - Network status monitoring
   - Graceful degradation

   ## Testing
   - Unit tests for IndexedDB operations
   - Background Sync API tests
   - Service Worker hook lifecycle tests
   - All tests pass: `npm run test`

   ## Browser Support
   - Chrome 40+
   - Firefox 44+
   - Edge 17+
   - Safari 11.1+
   - Graceful fallback on unsupported browsers

   ## Documentation
   - Complete API reference in `PWA_DOCUMENTATION.md`
   - Usage examples for all features
   - Performance optimization guide
   - Troubleshooting section

   Implements feature request: Offline PWA Mode with Background Sync and IndexedDB Cache (150 points)
   ```

5. Click **"Create pull request"**

## Troubleshooting

### Error: "Permission denied"
```powershell
# Set up SSH key authentication
ssh-keygen -t ed25519 -C "your-email@example.com"
# Add the public key to GitHub: https://github.com/settings/keys
```

### Error: "fatal: 'origin' does not appear to be a 'git' repository"
```powershell
# You're not in the correct directory
# Make sure you're in: C:\Users\LENOVO PC\Desktop\New folder (3)\stellar-alerts
```

### Error: "failed to push some refs to 'origin'"
```powershell
# Pull latest changes first
git fetch origin
git rebase origin/main

# Then try pushing again
git push -u origin feat/offline-pwa-mode
```

### Nothing happens (timeout)
```powershell
# Try with verbose output to see progress
git push -u origin feat/offline-pwa-mode -v

# Or try with a specific timeout
# (May require setting git config)
```

## Alternative: Using GitHub Desktop

If command line push fails, you can use GitHub Desktop:

1. Download: https://desktop.github.com
2. Sign in with your GitHub account
3. Open the repository in GitHub Desktop
4. Select the `feat/offline-pwa-mode` branch
5. Click "Publish branch" button
6. Click "Create Pull Request" button

## What Should Happen

After successful push and PR creation:

1. ✓ Branch appears on GitHub
2. ✓ PR opens with your description
3. ✓ GitHub Actions CI/CD runs automatically
4. ✓ Tests execute
5. ✓ You can request reviewers
6. ✓ Team can review and approve
7. ✓ Merge to main when ready

## Files Ready for Push

All 11 implementation files are present and ready:

```
✓ apps/web/public/manifest.json
✓ apps/web/public/sw.js
✓ apps/web/public/offline.html
✓ apps/web/src/lib/indexeddb.ts
✓ apps/web/src/lib/indexeddb.test.ts
✓ apps/web/src/lib/backgroundSync.ts
✓ apps/web/src/lib/backgroundSync.test.ts
✓ apps/web/src/hooks/useServiceWorker.ts
✓ apps/web/src/hooks/useServiceWorker.test.ts
✓ apps/web/PWA_DOCUMENTATION.md
✓ apps/web/next.config.ts (updated)
```

## Next Steps After PR Merge

1. CI/CD pipeline runs (tests, build, lint)
2. Code review and approval
3. Merge to main branch
4. Automatic deployment (if configured)
5. Monitor for any issues in production

---

**Need Help?**

For detailed documentation, see: `apps/web/PWA_DOCUMENTATION.md`

For implementation details, see: `Offline PWA Implementation Complete` (summary artifact)
