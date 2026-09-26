-- ROLLBACK TEMPLATE: Composite Index Removal
-- 
-- This template can be used to create a rollback migration if the composite
-- indexes need to be removed. Copy this content to a new migration file:
-- 
-- apps/api/prisma/migrations/YYYYMMDDHHMMSS_rollback_composite_indexes/migration.sql
--
-- Replace YYYYMMDDHHMMSS with current timestamp in format: 20260926140430

-- Drop composite indexes added in migration 20260926140430_add_wallet_delivery_composite_indexes

-- Remove Wallet (userId, createdAt) composite index
DROP INDEX IF EXISTS "Wallet_userId_createdAt_idx";

-- Remove NotificationDeliveryAttempt (deliveryKey, status) composite index  
DROP INDEX IF EXISTS "NotificationDeliveryAttempt_deliveryKey_status_idx";

-- Verification queries (for manual confirmation after rollback):
-- 
-- Check that indexes are gone:
-- SELECT indexname FROM pg_indexes WHERE indexname IN (
--   'Wallet_userId_createdAt_idx',
--   'NotificationDeliveryAttempt_deliveryKey_status_idx'
-- );
-- 
-- Should return 0 rows after successful rollback.

-- ROLLBACK IMPACT:
-- - Wallet queries will use userId index + sort operation (original performance)
-- - Delivery idempotency checks will use deliveryKey index + filter (original performance)  
-- - No data loss or application breakage
-- - All existing functionality preserved