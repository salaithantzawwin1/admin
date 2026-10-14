-- §17/§39 — Account classification happens at the PURCHASING stage: every PO
-- line carries the account it is charged to (the PR form no longer asks
-- requesters for Account/Asset). Nullable in the DB so PO lines created before
-- this phase stay valid; the API requires it for every NEW line.
ALTER TABLE "purchase_order_items" ADD COLUMN "accountId" UUID;

CREATE INDEX "purchase_order_items_accountId_idx" ON "purchase_order_items"("accountId");

ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
