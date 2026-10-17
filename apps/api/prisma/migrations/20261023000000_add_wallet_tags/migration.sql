-- Add custom color-coded category tags to tracked wallets
ALTER TABLE "wallets" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
