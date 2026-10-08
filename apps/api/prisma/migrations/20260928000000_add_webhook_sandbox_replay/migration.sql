-- Webhook dead-letter sandbox replay (#456).
-- Fully additive: one new table plus two relation back-references are not
-- materialized in SQL (Prisma relations only). No existing column is altered
-- and no data is dropped, so the migration is backward compatible and
-- roll-forward/roll-back safe.

-- CreateTable WebhookSandboxReplay
CREATE TABLE "WebhookSandboxReplay" (
    "id" TEXT NOT NULL,
    "deadLetterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "replayType" TEXT NOT NULL DEFAULT 'sandbox-replay',
    "requestEnvelope" JSONB,
    "requestHeaders" JSONB NOT NULL,
    "requestBody" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseHeaders" JSONB NOT NULL,
    "responseBody" TEXT NOT NULL,
    "responseDelayMs" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookSandboxReplay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex WebhookSandboxReplay
CREATE INDEX "WebhookSandboxReplay_deadLetterId_idx" ON "WebhookSandboxReplay"("deadLetterId");
CREATE INDEX "WebhookSandboxReplay_userId_idx" ON "WebhookSandboxReplay"("userId");
CREATE INDEX "WebhookSandboxReplay_createdAt_idx" ON "WebhookSandboxReplay"("createdAt");

-- AddForeignKey WebhookSandboxReplay
ALTER TABLE "WebhookSandboxReplay" ADD CONSTRAINT "WebhookSandboxReplay_deadLetterId_fkey" FOREIGN KEY ("deadLetterId") REFERENCES "DeadLetter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookSandboxReplay" ADD CONSTRAINT "WebhookSandboxReplay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
