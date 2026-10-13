-- Phase 5 (P3/P4): RFQ + Quotations + Quotation Comparison.
-- Extends the procurement foundation (migration 44). RFQ is a workflow
-- document (docType = RFQ) so its approval runs on the existing engine;
-- quotations attach to the RFQ for traceability, and the decisive
-- comparison row records the Procurement Officer's recommendation + reason.
--
-- Design mapping (AMS Procurement Management §11-14):
--   RFQ              ← RequestDocument (docType = PURCHASE_REQUEST? NO — new
--                      docType 'RFQ') + RFQ/Qualification/Vendor/Selection tables
--   Quotation        ← one row per vendor, items as rows, supplier = the vendor
--   QuotationItem    ← per-line unit price/qty/terms
--   QuotationComparison ← recommended vendor + justification (doc-level)

-- RFQ: the multi-vendor request for quotation (design §11). Mirrors the PR
-- identity for traceability: RequestDocument carries the workflow + doc number,
-- RFQ carries the procurement fields.
CREATE TABLE "rfqs" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,          -- link to RequestDocument (workflow)
    "requiredDate" TIMESTAMP(3),        -- when the vendors must answer
    "dueDate" TIMESTAMP(3),             -- quotation due date (design §11)
    "specification" TEXT,               -- item specification / requirements
    "notes" TEXT,                       -- extra instructions to vendors
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rfqs_requestId_fkey" FOREIGN KEY ("requestId")
        REFERENCES "request_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "rfqs_createdById_fkey" FOREIGN KEY ("createdById")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "rfqs_requestId_key" ON "rfqs"("requestId");
CREATE INDEX "rfqs_requestId_idx" ON "rfqs"("requestId");
CREATE INDEX "rfqs_status_idx" ON "request_documents"("status");

-- RFQ vendor master (design §11): which vendors received the request.
-- Same contact-history pattern as SupplierContactLog but scoped to RFQ.
CREATE TABLE "rfq_vendors" (
    "id" UUID NOT NULL,
    "rfqId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,         -- supplier = vendor for this org
    "priority" INTEGER NOT NULL DEFAULT 0,  -- attempt earliest seller first
    "contactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactReason" TEXT,               -- CALL/EMAIL/VISIT + context
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfq_vendors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rfq_vendors_rfqId_fkey" FOREIGN KEY ("rfqId")
        REFERENCES "rfqs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "rfq_vendors_supplierId_fkey" FOREIGN KEY ("supplierId")
        REFERENCES "suppliers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "rfq_vendors_createdById_fkey" FOREIGN KEY ("createdById")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "rfq_vendors_rfqId_idx" ON "rfq_vendors"("rfqId");
CREATE INDEX "rfq_vendors_supplierId_idx" ON "rfq_vendors"("supplierId");

-- Quotation: one vendor's answer to an RFQ (design §12).
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "rfqId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,         -- vendor that supplied this quote
    "quoteNumber" TEXT NOT NULL,        -- Q-#### per RFQ (local uniqueness)
    "quoteDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),             -- promised delivery date
    "validUntil" TIMESTAMP(3),          -- expiration of the offer
    "paymentTerms" TEXT,                -- e.g. 30 Days, COD (design §12)
    "taxIncluded" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quotations_rfqId_fkey" FOREIGN KEY ("rfqId")
        REFERENCES "rfqs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quotations_supplierId_fkey" FOREIGN KEY ("supplierId")
        REFERENCES "suppliers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quotations_createdById_fkey" FOREIGN KEY ("createdById")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "quotations_rfqId_idx" ON "quotations"("rfqId");
CREATE INDEX "quotations_supplierId_idx" ON "quotations"("supplierId");

-- Quotation line items (design §12): per-vendor items + prices.
CREATE TABLE "quotation_items" (
    "id" UUID NOT NULL,
    "quotationId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT,
    "unitPrice" DECIMAL(12, 2) NOT NULL,
    "taxPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0,
    "deliveryDays" INTEGER,             -- quoted delivery time (design §13)
    "warrantyMonths" INTEGER,           -- quoted warranty (design §13)
    "discountPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotation_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quotation_items_quotationId_fkey" FOREIGN KEY ("quotationId")
        REFERENCES "quotations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quotation_items_createdById_fkey" FOREIGN KEY ("createdById")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "quotation_items_quotationId_idx" ON "quotation_items"("quotationId");

-- Quotation comparison + vendor selection decision (design §13-14).
-- The Procurement Officer records the recommendation + justification here;
-- the comparison table is the live read model over quotations.
CREATE TABLE "quotation_comparisons" (
    "id" UUID NOT NULL,
    "rfqId" UUID NOT NULL,
    "recommendedSupplierId" UUID NOT NULL,
    "recommendedQuoteId" UUID NOT NULL,
    "selectionReason" TEXT NOT NULL,    -- justification for vendor selection
    "supportingDocument" TEXT,          -- file/brief reference (design §14)
    "status" TEXT NOT NULL DEFAULT 'PENDING_SELECTION', -- PENDING | SELECTED | REJECTED
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotation_comparisons_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quotation_comparisons_rfqId_fkey" FOREIGN KEY ("rfqId")
        REFERENCES "rfqs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quotation_comparisons_recommendedSupplierId_fkey" FOREIGN KEY ("recommendedSupplierId")
        REFERENCES "suppliers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quotation_comparisons_recommendedQuoteId_fkey" FOREIGN KEY ("recommendedQuoteId")
        REFERENCES "quotations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quotation_comparisons_createdById_fkey" FOREIGN KEY ("createdById")
        REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "quotation_comparisons_rfqId_idx" ON "quotation_comparisons"("rfqId");
CREATE INDEX "quotation_comparisons_status_idx" ON "quotation_comparisons"("status");
