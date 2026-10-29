-- Asset Setup tab on the asset register (asset-register): CATEGORY, LOCATION
-- and CUSTODIAN get full CRUD. Categories and locations already exist; the
-- custodian list is new. Asset.custodian deliberately stays free text — an
-- asset's custody record must not rewrite itself when this list changes — so
-- this table is the picker source, not a foreign key target.
--
-- Backfill: every distinct custody value already stored on an asset becomes a
-- row, so the picker starts populated and legacy values can be picked again.

CREATE TABLE "custodians" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custodians_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custodians_name_key" ON "custodians"("name");

INSERT INTO "custodians" ("name")
SELECT DISTINCT TRIM("custodian") FROM "assets"
WHERE "custodian" IS NOT NULL AND TRIM("custodian") <> ''
ON CONFLICT ("name") DO NOTHING;
