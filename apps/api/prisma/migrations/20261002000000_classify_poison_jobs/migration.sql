ALTER TABLE "DeadLetter"
  ADD COLUMN "failureClass" TEXT NOT NULL DEFAULT 'permanent',
  ADD COLUMN "failureReason" TEXT,
  ADD COLUMN "jobId" TEXT,
  ADD COLUMN "attemptsMade" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxAttempts" INTEGER,
  ADD COLUMN "quarantinedAt" TIMESTAMP(3);

CREATE INDEX "DeadLetter_jobId_idx" ON "DeadLetter"("jobId");
CREATE INDEX "DeadLetter_failureClass_idx" ON "DeadLetter"("failureClass");