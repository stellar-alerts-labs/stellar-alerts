-- Add composite indexes for query optimization
-- 
-- Wallet (userId, createdAt) - supports getWallets() query pattern:
-- WHERE userId = ? ORDER BY createdAt DESC
--
-- NotificationDeliveryAttempt (deliveryKey, status) - supports delivery idempotency:  
-- WHERE deliveryKey = ? AND status = 'delivered'

-- CreateIndex
CREATE INDEX "Wallet_userId_createdAt_idx" ON "Wallet"("userId", "createdAt");

-- CreateIndex  
CREATE INDEX "NotificationDeliveryAttempt_deliveryKey_status_idx" ON "NotificationDeliveryAttempt"("deliveryKey", "status");