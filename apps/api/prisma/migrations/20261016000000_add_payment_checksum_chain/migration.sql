-- CreateTable
CREATE TABLE "PaymentChecksum" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "sequence" SERIAL NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "previousHash" TEXT NOT NULL,
    "chainHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentChecksum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyChecksumRoot" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "merkleRoot" TEXT NOT NULL,
    "leafCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyChecksumRoot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentChecksum_paymentId_key" ON "PaymentChecksum"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentChecksum_sequence_idx" ON "PaymentChecksum"("sequence");

-- CreateIndex
CREATE INDEX "PaymentChecksum_createdAt_idx" ON "PaymentChecksum"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyChecksumRoot_date_key" ON "DailyChecksumRoot"("date");

-- AddForeignKey
ALTER TABLE "PaymentChecksum" ADD CONSTRAINT "PaymentChecksum_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
