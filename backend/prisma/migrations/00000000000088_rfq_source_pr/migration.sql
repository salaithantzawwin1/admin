-- RFQ → PR traceability: an RFQ can be raised for one approved purchase request.
-- The PO form then defaults its supplier to a vendor that quoted on that RFQ
-- (recommendation first, then the only vendor that answered).
ALTER TABLE "rfqs" ADD COLUMN "purchaseRequestId" UUID;

ALTER TABLE "rfqs"
  ADD CONSTRAINT "rfqs_purchaseRequestId_fkey"
  FOREIGN KEY ("purchaseRequestId") REFERENCES "purchase_requests"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "rfqs_purchaseRequestId_idx" ON "rfqs"("purchaseRequestId");
