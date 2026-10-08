-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "discordWebhookUrl" TEXT,
ADD COLUMN     "discordEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slackWebhookUrl" TEXT,
ADD COLUMN     "slackEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DeliveryLog" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryLog_paymentId_idx" ON "DeliveryLog"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryLog_paymentId_channel_key" ON "DeliveryLog"("paymentId", "channel");
