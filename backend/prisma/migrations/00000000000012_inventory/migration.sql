-- AMS — Inventory / Store Management (Plan §12)
-- Items master, stock transactions (IN/OUT ledger), office supply issue requests
-- (header + lines) hooked into the reusable approval workflow.

-- CreateEnum
CREATE TYPE "ItemCategory" AS ENUM ('STATIONERY', 'BOOKS', 'PAPER', 'ELECTRONICS', 'CLEANING', 'KITCHEN', 'FURNITURE', 'IT_SUPPLIES', 'OTHER');
CREATE TYPE "StockTxType" AS ENUM ('PURCHASE', 'ISSUE', 'RETURN', 'ADJUSTMENT');
CREATE TYPE "SupplyLineStatus" AS ENUM ('PENDING', 'FULFILLED', 'OUT_OF_STOCK');

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ItemCategory" NOT NULL DEFAULT 'STATIONERY',
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "balance" INTEGER NOT NULL DEFAULT 0,
    "minStock" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_transactions" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "type" "StockTxType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reference" TEXT,
    "requestId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "office_supply_requests" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "office_supply_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "office_supply_request_lines" (
    "id" UUID NOT NULL,
    "supplyRequestId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "SupplyLineStatus" NOT NULL DEFAULT 'PENDING',
    "fulfilledQty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "office_supply_request_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_code_key" ON "inventory_items"("code");
CREATE INDEX "inventory_items_category_idx" ON "inventory_items"("category");
CREATE INDEX "inventory_items_isActive_idx" ON "inventory_items"("isActive");
CREATE INDEX "stock_transactions_itemId_createdAt_idx" ON "stock_transactions"("itemId", "createdAt");
CREATE INDEX "stock_transactions_requestId_idx" ON "stock_transactions"("requestId");
CREATE INDEX "office_supply_request_lines_supplyRequestId_idx" ON "office_supply_request_lines"("supplyRequestId");
CREATE INDEX "office_supply_request_lines_itemId_idx" ON "office_supply_request_lines"("itemId");

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "request_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "office_supply_requests" ADD CONSTRAINT "office_supply_requests_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "request_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "office_supply_request_lines" ADD CONSTRAINT "office_supply_request_lines_supplyRequestId_fkey" FOREIGN KEY ("supplyRequestId") REFERENCES "office_supply_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "office_supply_request_lines" ADD CONSTRAINT "office_supply_request_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
