-- AMS — stock IN pricing + spending report + LOW_STOCK notification type

ALTER TABLE "inventory_items" ADD COLUMN "lastUnitPrice" DECIMAL(12,2);
ALTER TABLE "stock_transactions" ADD COLUMN "unitPrice" DECIMAL(12,2);

ALTER TYPE "NotificationType" ADD VALUE 'LOW_STOCK';
