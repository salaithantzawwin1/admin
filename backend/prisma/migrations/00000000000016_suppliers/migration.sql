-- AMS — supplier master data for purchases

CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "suppliers_name_key" ON "suppliers"("name");

ALTER TABLE "stock_transactions" ADD COLUMN "supplierId" UUID;

-- backfill: existing free-text supplier values become master rows
INSERT INTO "suppliers" ("id", "name", "updatedAt")
SELECT gen_random_uuid(), t."supplier", now()
FROM (SELECT DISTINCT "supplier" FROM "stock_transactions" WHERE "supplier" IS NOT NULL) t;

UPDATE "stock_transactions" t
SET "supplierId" = s.id
FROM "suppliers" s
WHERE t."supplier" = s."name";

ALTER TABLE "stock_transactions"
  ADD CONSTRAINT "stock_transactions_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
