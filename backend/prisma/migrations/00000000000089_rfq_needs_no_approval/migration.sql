-- An RFQ records that vendors were asked; it no longer waits for a signature.
-- Legacy drafts/pending RFQs become APPROVED so they leave every approval inbox
-- and badge count, and can be closed/finished like newly created ones.
UPDATE "request_documents"
SET "status" = 'APPROVED',
    "currentLevel" = GREATEST("currentLevel", 1),
    "submittedAt" = COALESCE("submittedAt", now()),
    "updatedAt" = now()
WHERE "docType" = 'RFQ'
  AND "status" IN ('DRAFT', 'SUBMITTED', 'PENDING_APPROVAL');
