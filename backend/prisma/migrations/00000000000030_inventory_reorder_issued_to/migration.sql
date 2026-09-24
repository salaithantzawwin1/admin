-- Reorder level: per-item target the auto-reorder suggestion aims for.
-- NULL = no explicit target (suggestions fall back to the alert threshold).
ALTER TABLE "inventory_items" ADD COLUMN "reorderLevel" INTEGER;

-- Stock ledger rows now record the issuing employee directly (denormalised —
-- legacy rows fall back to the linked supply request's requester).
ALTER TABLE "stock_transactions" ADD COLUMN "issuedToEmployeeId" UUID;

CREATE INDEX "stock_transactions_issuedToEmployeeId_idx" ON "stock_transactions"("issuedToEmployeeId");

ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_issuedToEmployeeId_fkey"
  FOREIGN KEY ("issuedToEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
