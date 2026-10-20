-- GLG Procurement ERP W4 (docs/GLG_Procurement_ERP_Module.md §W4 — design §36
-- purchase-type classification): NORMAL / EMERGENCY / DIRECT / PETTY_CASH on
-- the PR and the PO. EMERGENCY/DIRECT require a reason (service-validated —
-- the audited exception path for receiving without the full PR chain).
-- Defaults keep every existing row valid.

ALTER TABLE "purchase_requests" ADD COLUMN "purchaseType" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "purchase_requests" ADD COLUMN "purchaseReason" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "purchaseType" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "purchase_orders" ADD COLUMN "purchaseReason" TEXT;
CREATE INDEX "purchase_requests_purchaseType_idx" ON "purchase_requests"("purchaseType");
CREATE INDEX "purchase_orders_purchaseType_idx" ON "purchase_orders"("purchaseType");
