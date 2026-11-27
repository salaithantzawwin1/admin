-- v2 P1-1: petty-cash expense <-> invoice link.
--
-- The float ledger stops being blind to the bills it settles: an EXPENSE may
-- name the invoice it paid, and the payment it creates points back at it with a
-- UNIQUE key, so one cash payment can never be counted twice. Additive only —
-- existing rows keep invoiceId/paymentId NULL (no guessed links, v2 BR-11).

ALTER TABLE "petty_cash_transactions" ADD COLUMN "invoiceId" UUID;
ALTER TABLE "petty_cash_transactions" ADD COLUMN "supplierId" UUID;

ALTER TABLE "petty_cash_transactions"
  ADD CONSTRAINT "petty_cash_transactions_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "petty_cash_transactions"
  ADD CONSTRAINT "petty_cash_transactions_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "petty_cash_transactions_invoiceId_idx" ON "petty_cash_transactions"("invoiceId");
CREATE INDEX "petty_cash_transactions_supplierId_idx" ON "petty_cash_transactions"("supplierId");

-- v2 P1-1: where the money came from (PETTY_CASH / COMPANY_CASH / COMPANY_BANK).
-- String, not an enum: a later PERSONAL value is additive (v2 D-12).
ALTER TABLE "payments" ADD COLUMN "fundingSource" TEXT;
ALTER TABLE "payments" ADD COLUMN "payerUserId" UUID;
ALTER TABLE "payments" ADD COLUMN "payerName" TEXT;
ALTER TABLE "payments" ADD COLUMN "pettyCashTransactionId" UUID;

CREATE UNIQUE INDEX "payments_pettyCashTransactionId_key" ON "payments"("pettyCashTransactionId");
CREATE INDEX "payments_fundingSource_idx" ON "payments"("fundingSource");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_payerUserId_fkey"
  FOREIGN KEY ("payerUserId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_pettyCashTransactionId_fkey"
  FOREIGN KEY ("pettyCashTransactionId") REFERENCES "petty_cash_transactions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
