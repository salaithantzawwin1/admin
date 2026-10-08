-- Procurement foundation (Design: AMS Procurement Management §28; Spec §15–17)
-- Account = "what was the money spent on", Asset = "which asset is it related to".
-- PurchaseRequest carries the procurement fields for PURCHASE_REQUEST workflow docs.

CREATE TABLE "account_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_categories_name_key" ON "account_categories"("name");

CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "categoryId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");
CREATE INDEX "accounts_categoryId_idx" ON "accounts"("categoryId");

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "account_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "asset_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_categories_name_key" ON "asset_categories"("name");

CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "locations_name_key" ON "locations"("name");

CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "assetCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" UUID,
    "brand" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "locationId" UUID,
    "purchaseDate" TIMESTAMP(3),
    "purchaseCost" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assets_assetCode_key" ON "assets"("assetCode");
CREATE INDEX "assets_categoryId_idx" ON "assets"("categoryId");
CREATE INDEX "assets_locationId_idx" ON "assets"("locationId");

ALTER TABLE "assets" ADD CONSTRAINT "assets_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "asset_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "assets" ADD CONSTRAINT "assets_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PR workflow status lives on request_documents; this table carries the
-- procurement-specific fields (design §5: required date, priority,
-- justification, budget code).
DO $$ BEGIN
  CREATE TYPE "PurchasePriority" AS ENUM ('NORMAL', 'URGENT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "purchase_requests" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "requiredDate" TIMESTAMP(3),
    "priority" "PurchasePriority" NOT NULL DEFAULT 'NORMAL',
    "justification" TEXT,
    "budgetCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_requests_requestId_key" ON "purchase_requests"("requestId");

ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "request_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PR lines: description, qty, unit, estimated price + optional Account/Asset refs
-- (nullable until the Finance/Asset modules fully land — spec §18).
CREATE TABLE "purchase_request_items" (
    "id" UUID NOT NULL,
    "purchaseRequestId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT,
    "estimatedUnitPrice" DECIMAL(12,2),
    "accountId" UUID,
    "assetId" UUID,

    CONSTRAINT "purchase_request_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_request_items_purchaseRequestId_idx" ON "purchase_request_items"("purchaseRequestId");

ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_purchaseRequestId_fkey"
  FOREIGN KEY ("purchaseRequestId") REFERENCES "purchase_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
