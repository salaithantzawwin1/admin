-- A2 — an RFQ is a record, not a workflow document.
--
-- The old rfqs table is renamed in place: every row keeps its id, so
-- rfq_vendors / quotations / quotation_comparisons FKs keep pointing at the same
-- rows and no child data moves. The fields that used to live on the workflow
-- document (docNumber, title, description, department) are copied in, and the
-- workflow-only status becomes OPEN / CLOSED / CANCELLED.
ALTER TABLE "rfqs" RENAME TO "quotation_requests";

CREATE TYPE "QuotationRequestStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

ALTER TABLE "quotation_requests"
  ADD COLUMN "docNumber" TEXT,
  ADD COLUMN "title" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "status" "QuotationRequestStatus" NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "departmentId" UUID;

UPDATE "quotation_requests" qr
SET "docNumber" = rd."docNumber",
    "title" = rd."title",
    "description" = rd."description",
    "departmentId" = rd."departmentId",
    "status" = CASE
      WHEN rd."status" = 'CLOSED' THEN 'CLOSED'::"QuotationRequestStatus"
      WHEN rd."status" IN ('CANCELLED', 'REJECTED') THEN 'CANCELLED'::"QuotationRequestStatus"
      ELSE 'OPEN'::"QuotationRequestStatus"
    END
FROM "request_documents" rd
WHERE rd."id" = qr."requestId";

ALTER TABLE "quotation_requests"
  ALTER COLUMN "docNumber" SET NOT NULL,
  ALTER COLUMN "title" SET NOT NULL;

ALTER TABLE "quotation_requests" DROP CONSTRAINT "rfqs_requestId_fkey";
ALTER TABLE "quotation_requests" DROP COLUMN "requestId";

ALTER TABLE "quotation_requests" RENAME COLUMN "createdById" TO "requestedById";
ALTER TABLE "quotation_requests" RENAME CONSTRAINT "rfqs_createdById_fkey" TO "quotation_requests_requestedById_fkey";

CREATE UNIQUE INDEX "quotation_requests_docNumber_key" ON "quotation_requests"("docNumber");

ALTER TABLE "quotation_requests"
  ADD CONSTRAINT "quotation_requests_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The workflow documents that used to carry RFQs stay as history: archived, not
-- deleted, so their approval trail and attachments remain readable.
UPDATE "request_documents"
SET "archivedAt" = now(), "updatedAt" = now()
WHERE "docType" = 'RFQ' AND "archivedAt" IS NULL;
