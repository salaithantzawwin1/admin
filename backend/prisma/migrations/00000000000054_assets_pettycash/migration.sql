-- VMS/AMS gap analysis R-batch (2026-10-19):
--  1. §39 asset registration from procurement — PO lines link to the asset they
--     registered (cost/serial provenance), section-taggable for the register UI.
--  2. §16/§40 asset lifecycle — asset_movements is the append-only history feed
--     (REGISTER / TRANSFER / DISPOSE / RESTORE / MAINTENANCE); custody lives in
--     the asset row + its movement trail, never denormalized elsewhere.
--  3. §21/§36 petty cash — append-only TOPUP/EXPENSE ledger; balance is always
--     Σ TOPUP − Σ EXPENSE (spec §23: transactions are the source of truth).
-- Notes: every table keeps the Prisma convention (updatedAt omitted only where
-- the model has none — these three models are event rows without updatedAt
-- except where columns exist, matching migration-53's lesson: raw INSERTs must
-- supply every NOT NULL column without a DB default).

-- ---- 1. PO line → registered asset (§39) ----
ALTER TABLE "purchase_order_items" ADD COLUMN "assetId" UUID;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "purchase_order_items_assetId_idx" ON "purchase_order_items"("assetId");

-- ---- 2. Asset movement history (§16/§40) ----
CREATE TABLE "asset_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assetId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "fromLocationId" UUID,
    "toLocationId" UUID,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_movements_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_fromLocationId_fkey"
  FOREIGN KEY ("fromLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_toLocationId_fkey"
  FOREIGN KEY ("toLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "asset_movements_assetId_createdAt_idx" ON "asset_movements"("assetId", "createdAt");

-- ---- custody: responsible person/department on the asset row (§40) ----
ALTER TABLE "assets" ADD COLUMN "custodian" TEXT;
CREATE INDEX "assets_status_idx" ON "assets"("status");

-- ---- 3. Petty cash ledger (§21/§36) ----
CREATE TABLE "petty_cash_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payee" TEXT,
    "accountId" UUID,
    "description" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "petty_cash_transactions_code_key" ON "petty_cash_transactions"("code");
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "petty_cash_transactions_date_idx" ON "petty_cash_transactions"("date");
CREATE INDEX "petty_cash_transactions_type_idx" ON "petty_cash_transactions"("type");
