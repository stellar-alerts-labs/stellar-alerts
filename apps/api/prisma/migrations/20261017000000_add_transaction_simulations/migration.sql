-- CreateTable
CREATE TABLE "TransactionSimulation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "envelopeHash" TEXT NOT NULL,
    "innerEnvelopeHash" TEXT NOT NULL,
    "networkPassphrase" TEXT NOT NULL,
    "isFeeBump" BOOLEAN NOT NULL DEFAULT false,
    "riskLevel" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "indicatorCodes" TEXT ARRAY DEFAULT ARRAY[]::TEXT[],
    "report" JSONB NOT NULL,
    "footprintDiff" JSONB,
    "requestSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionSimulation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransactionSimulation_userId_createdAt_idx" ON "TransactionSimulation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionSimulation_envelopeHash_idx" ON "TransactionSimulation"("envelopeHash");

-- CreateIndex
CREATE INDEX "TransactionSimulation_riskLevel_idx" ON "TransactionSimulation"("riskLevel");

-- CreateIndex
CREATE INDEX "TransactionSimulation_createdAt_idx" ON "TransactionSimulation"("createdAt");

-- AddForeignKey
ALTER TABLE "TransactionSimulation" ADD CONSTRAINT "TransactionSimulation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
