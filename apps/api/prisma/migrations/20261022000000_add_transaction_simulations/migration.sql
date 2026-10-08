-- Pre-execution transaction simulation results.
-- Fully additive: one new table plus a back-reference on `User` that Prisma
-- models only (no SQL column). No existing column is altered and no data is
-- dropped, so the migration is backward compatible and roll-forward/roll-back
-- safe. See docs/simulation.md for the rollout and compatibility notes.

-- CreateTable
CREATE TABLE "TransactionSimulation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceAccount" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'PUBLIC',
    "label" TEXT,
    "envelopeHash" TEXT,
    "score" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "blockExecution" BOOLEAN NOT NULL DEFAULT false,
    "indicatorCodes" TEXT[] NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionSimulation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransactionSimulation_userId_createdAt_idx" ON "TransactionSimulation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionSimulation_band_createdAt_idx" ON "TransactionSimulation"("band", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionSimulation_sourceAccount_createdAt_idx" ON "TransactionSimulation"("sourceAccount", "createdAt");

-- AddForeignKey
ALTER TABLE "TransactionSimulation" ADD CONSTRAINT "TransactionSimulation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
