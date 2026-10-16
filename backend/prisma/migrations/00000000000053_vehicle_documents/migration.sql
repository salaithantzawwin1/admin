-- VMS Phase B (Vehicle spec §6.1/§6.2/§6.5) — the document register.
--  1. configurable document types (§6.1) with the §6.5 mandatory_for_dispatch
--     policy flag — seeded FALSE, Administration opts in per type, so no
--     existing trip flow changes behaviour until someone flips a flag.
--  2. per-vehicle document records with renewal lineage (§6.2): a renewal
--     INSERTs a new row and points the old one at it — history preserved.
--  3. document → attachment reference (§6.2 "attachment/file reference") —
--     the FK lives on vehicle_documents so an attachment keeps working for
--     requests/announcements exactly as before.
--  4. seed of the spec's suggested default types (§6.1) + backfill of today's
--     real dates from the legacy vehicles.registration/insurance columns, so
--     the register starts with real data instead of an empty "missing" view
--     (driver licence is deliberately NOT a type — spec §6.1 keeps licences on
--     the driver record, which Phase A already alerts).

CREATE TABLE "vehicle_document_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vehicleType" "VehicleType",
    "mandatoryForDispatch" BOOLEAN NOT NULL DEFAULT false,
    "allowNoExpiry" BOOLEAN NOT NULL DEFAULT false,
    "warningDays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_document_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vehicle_document_types_code_key" ON "vehicle_document_types"("code");

-- Renewal workflow state of a document record (spec §6.2).
CREATE TYPE "DocumentRenewalStatus" AS ENUM ('NOT_STARTED', 'REQUESTED', 'IN_PROGRESS', 'RENEWED', 'NOT_REQUIRED');

CREATE TABLE "vehicle_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicleId" UUID NOT NULL,
    "documentTypeId" UUID NOT NULL,
    "documentNo" TEXT,
    "issuingAuthority" TEXT,
    "issueDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "renewalStatus" "DocumentRenewalStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "previousId" UUID,
    "supersededById" UUID,
    "notes" TEXT,
    "attachmentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vehicle_documents_vehicleId_idx" ON "vehicle_documents"("vehicleId");
CREATE INDEX "vehicle_documents_documentTypeId_idx" ON "vehicle_documents"("documentTypeId");
CREATE INDEX "vehicle_documents_expiryDate_idx" ON "vehicle_documents"("expiryDate");
CREATE INDEX "vehicle_documents_supersededById_idx" ON "vehicle_documents"("supersededById");
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "vehicle_document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---- spec §6.1 suggested default document types (idempotent) ----
INSERT INTO "vehicle_document_types" ("code", "name", "sortOrder") VALUES
    ('REGISTRATION', 'Vehicle registration / license', 1),
    ('ROAD_TAX', 'Road tax', 2),
    ('INSURANCE', 'Motor insurance', 3),
    ('COMPREHENSIVE_INSURANCE', 'Comprehensive insurance', 4),
    ('THIRD_PARTY_INSURANCE', 'Third-party insurance', 5),
    ('INSPECTION', 'Inspection / roadworthiness certificate', 6),
    ('ROUTE_PERMIT', 'Commercial / route permit', 7),
    ('LEASE_CONTRACT', 'Lease / rental contract', 8),
    ('CUSTOMS_CERTIFICATE', 'Import / customs certificate', 9),
    ('OTHER', 'Other configurable document', 10)
ON CONFLICT ("code") DO NOTHING;

-- ---- backfill: legacy expiry columns become current register records ----
-- Issue dates are unknown (the old columns only ever stored the expiry), so
-- issueDate stays NULL and renewalStatus starts NOT_STARTED.
INSERT INTO "vehicle_documents" ("vehicleId", "documentTypeId", "expiryDate")
SELECT v."id", t."id", v."registrationExpiry"
FROM "vehicles" v
JOIN "vehicle_document_types" t ON t."code" = 'REGISTRATION'
WHERE v."registrationExpiry" IS NOT NULL;

INSERT INTO "vehicle_documents" ("vehicleId", "documentTypeId", "expiryDate")
SELECT v."id", t."id", v."insuranceExpiry"
FROM "vehicles" v
JOIN "vehicle_document_types" t ON t."code" = 'INSURANCE'
WHERE v."insuranceExpiry" IS NOT NULL;
