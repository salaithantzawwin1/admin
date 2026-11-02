-- §14/§24 — issue stock straight to a fixed asset.
--
-- A cartridge is a stock item, not an asset: counting it as an asset would lose
-- the "5 left in the store" number. But the office still needs to answer "which
-- printer did this cartridge go into, and what has that printer cost us". So an
-- ISSUE row may now point at the asset it was used on, and the service writes a
-- CONSUMABLE row into asset_costs at the item's last purchase price.
--
-- purpose tells the issue apart from a normal staff hand-out:
--   ASSET_USE   — consumed by a machine (toner, filter, paper)
--   MAINTENANCE — consumed during a maintenance job (reference holds MRC-…)

ALTER TABLE "stock_transactions" ADD COLUMN "assetId" UUID;
ALTER TABLE "stock_transactions" ADD COLUMN "purpose" TEXT;

CREATE INDEX "stock_transactions_assetId_idx" ON "stock_transactions"("assetId");

ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
