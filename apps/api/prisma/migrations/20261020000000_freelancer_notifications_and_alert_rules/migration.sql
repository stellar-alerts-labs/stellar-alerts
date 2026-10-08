-- AlterTable AlertRule (#257)
ALTER TABLE "AlertRule" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AlertRule" ADD COLUMN IF NOT EXISTS "maxAmount" DECIMAL(65,30);
ALTER TABLE "AlertRule" ADD COLUMN IF NOT EXISTS "memo" TEXT;
ALTER TABLE "AlertRule" ADD COLUMN IF NOT EXISTS "channels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex for AlertRule
CREATE INDEX IF NOT EXISTS "AlertRule_userId_isActive_idx" ON "AlertRule"("userId", "isActive");
CREATE INDEX IF NOT EXISTS "AlertRule_walletId_isActive_idx" ON "AlertRule"("walletId", "isActive");

-- AlterTable NotificationPreference (#259, #253)
ALTER TABLE "NotificationPreference" ADD COLUMN IF NOT EXISTS "pushChannelAddress" TEXT;
ALTER TABLE "NotificationPreference" ADD COLUMN IF NOT EXISTS "pushEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreference" ADD COLUMN IF NOT EXISTS "receiptPreference" TEXT NOT NULL DEFAULT 'instant';
ALTER TABLE "NotificationPreference" ADD COLUMN IF NOT EXISTS "assetFilters" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "NotificationPreference" ADD COLUMN IF NOT EXISTS "minAmount" DECIMAL(65,30);
ALTER TABLE "NotificationPreference" ADD COLUMN IF NOT EXISTS "enabledChannels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable TelegramSyncCode (#260)
CREATE TABLE IF NOT EXISTS "TelegramSyncCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT,
    "code" TEXT NOT NULL,
    "chatId" TEXT,
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramSyncCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex for TelegramSyncCode
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramSyncCode_code_key" ON "TelegramSyncCode"("code");
CREATE INDEX IF NOT EXISTS "TelegramSyncCode_userId_idx" ON "TelegramSyncCode"("userId");
CREATE INDEX IF NOT EXISTS "TelegramSyncCode_expiresAt_idx" ON "TelegramSyncCode"("expiresAt");

-- AddForeignKey for TelegramSyncCode
ALTER TABLE "TelegramSyncCode" ADD CONSTRAINT "TelegramSyncCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
