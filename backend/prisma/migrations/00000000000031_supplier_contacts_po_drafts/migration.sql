-- Vendor management: contact log + PO drafts (Purchasing works vendors here)

-- Who at the supplier was contacted, when, by whom, about what.
CREATE TABLE "supplier_contact_logs" (
    "id" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "contactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "person" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'CALL',
    "summary" TEXT NOT NULL,
    "followUpAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_contact_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "supplier_contact_logs_supplierId_idx" ON "supplier_contact_logs"("supplierId");

ALTER TABLE "supplier_contact_logs" ADD CONSTRAINT "supplier_contact_logs_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supplier_contact_logs" ADD CONSTRAINT "supplier_contact_logs_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PO drafts raised from reorder suggestions / vendor quotes. Submitting pushes
-- the draft through the PURCHASE_REQUEST approval workflow (doc becomes PR-…).
CREATE TABLE "supplier_purchase_drafts" (
    "id" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "requestId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_purchase_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "supplier_purchase_drafts_supplierId_idx" ON "supplier_purchase_drafts"("supplierId");

ALTER TABLE "supplier_purchase_drafts" ADD CONSTRAINT "supplier_purchase_drafts_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supplier_purchase_drafts" ADD CONSTRAINT "supplier_purchase_drafts_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "request_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_purchase_drafts" ADD CONSTRAINT "supplier_purchase_drafts_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lines of a PO draft (item + qty + quoted unit price).
CREATE TABLE "supplier_purchase_draft_lines" (
    "id" UUID NOT NULL,
    "draftId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2),

    CONSTRAINT "supplier_purchase_draft_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "supplier_purchase_draft_lines_draftId_idx" ON "supplier_purchase_draft_lines"("draftId");

ALTER TABLE "supplier_purchase_draft_lines" ADD CONSTRAINT "supplier_purchase_draft_lines_draftId_fkey"
  FOREIGN KEY ("draftId") REFERENCES "supplier_purchase_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supplier_purchase_draft_lines" ADD CONSTRAINT "supplier_purchase_draft_lines_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
