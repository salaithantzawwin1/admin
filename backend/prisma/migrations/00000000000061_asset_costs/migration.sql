-- §14.5/§17 — asset cost ledger: every cost event AFTER acquisition (service,
-- spare part, consumable, freight) that belongs to one fixed asset, in one
-- table. The purchase price itself stays on assets."purchaseCost", so
-- total cost of ownership = purchaseCost + SUM(asset_costs.amount).

-- CreateTable
CREATE TABLE "asset_costs" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER,
    "accountId" UUID,
    "supplierId" UUID,
    "description" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_costs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (the asset page reads one asset's rows newest first)
CREATE INDEX "asset_costs_assetId_date_idx" ON "asset_costs"("assetId", "date");

-- CreateIndex (one row per invoice line — re-posting never duplicates spend)
CREATE UNIQUE INDEX "asset_costs_sourceType_sourceId_key" ON "asset_costs"("sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "asset_costs" ADD CONSTRAINT "asset_costs_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_costs" ADD CONSTRAINT "asset_costs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_costs" ADD CONSTRAINT "asset_costs_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_costs" ADD CONSTRAINT "asset_costs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: invoice lines that were already tagged to an asset (§24 assetId)
-- on APPROVED/POSTED bills are real spend on that asset — seed them so the
-- ledger starts with the history the register already has instead of empty.
-- kind PURCHASE keeps the line honest: the description carries what it was.
INSERT INTO "asset_costs" (
    "id", "assetId", "date", "kind", "amount", "quantity",
    "accountId", "supplierId", "description",
    "sourceType", "sourceId", "createdById", "createdAt"
)
SELECT
    gen_random_uuid(),
    ii."assetId",
    i."invoiceDate",
    'PURCHASE',
    ROUND(ii."unitPrice" * ii.quantity, 2),
    ii.quantity,
    ii."accountId",
    i."supplierId",
    TRIM(ii.description) || ' — ' || i."invoiceNumber",
    'INVOICE',
    ii.id,
    i."createdById",
    now()
FROM "invoice_items" ii
JOIN "invoices" i ON i.id = ii."invoiceId"
WHERE ii."assetId" IS NOT NULL
  AND i.status IN ('APPROVED', 'POSTED')
ON CONFLICT ("sourceType", "sourceId") DO NOTHING;
