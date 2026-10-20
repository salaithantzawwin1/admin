-- GLG Procurement ERP W1 (docs/GLG_Procurement_ERP_Module.md §W1 — vendor payments,
-- design §26 / Plan §9 "Invoice & Payment for Finance"):
--  1. payments — append-only register (PY-… via document_sequences); one row per
--     money movement against an invoice. Wrong payments are deleted (audited) and
--     re-entered, never edited (petty-cash ledger convention).
--  2. invoices rollups — paidAmount + paymentStatus are maintained inside the
--     same transaction as every payment write (UNPAID / PARTIALLY_PAID / PAID).
-- Rollups start at 0/UNPAID: no live payments exist before this migration.

ALTER TABLE "invoices" ADD COLUMN "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID';
CREATE INDEX "invoices_paymentStatus_idx" ON "invoices"("paymentStatus");

CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "paymentNumber" TEXT NOT NULL,
    "invoiceId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payments_paymentNumber_key" ON "payments"("paymentNumber");
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "payments_invoiceId_idx" ON "payments"("invoiceId");
CREATE INDEX "payments_date_idx" ON "payments"("date");
-- DB-level backstop for the service-side over-payment guard (§W1 Controls)
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);
