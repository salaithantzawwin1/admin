-- Invoice attachments: the generalized attachment row gains one more owner.
-- A bill photo / PDF (and any supporting paper) belongs to its invoice, exactly
-- like request and announcement attachments; deleting the invoice cascades.

ALTER TABLE "attachments" ADD COLUMN "invoiceId" UUID;

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "attachments_invoiceId_idx" ON "attachments"("invoiceId");
