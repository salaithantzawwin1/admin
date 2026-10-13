-- Phase 5 (P3/P4) extras that were missing in migration 48:
--  1. The RFQ docType value on the workflow document enum (rfq rows are
--     RequestDocuments with docType = RFQ).
--  2. One comparison decision per RFQ (1:1 with rfqs) — Prisma requires a
--     unique FK for the Rfq.comparison back-reference.
-- NOTE: PG 12+ allows ALTER TYPE ADD VALUE inside a transaction, provided
-- the new value is not USED in the same transaction (we only add it here).

ALTER TYPE "RequestDocType" ADD VALUE 'RFQ';

CREATE UNIQUE INDEX "quotation_comparisons_rfqId_key" ON "quotation_comparisons"("rfqId");
