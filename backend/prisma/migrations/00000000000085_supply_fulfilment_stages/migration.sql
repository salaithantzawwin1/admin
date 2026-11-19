-- Office supply fulfilment stages: approved → buying (with an expected
-- collection day) → ready for pickup → handed over.
-- Stock is deducted at hand-over (fulfill), never at approval.
ALTER TABLE "office_supply_requests"
  ADD COLUMN "expectedReadyOn" TIMESTAMP(3),
  ADD COLUMN "purchasingAt" TIMESTAMP(3),
  ADD COLUMN "readyAt" TIMESTAMP(3),
  ADD COLUMN "purchaseNote" TEXT;

-- Two requester-facing notifications for the new stages.
ALTER TYPE "NotificationType" ADD VALUE 'SUPPLY_PURCHASING';
ALTER TYPE "NotificationType" ADD VALUE 'SUPPLY_READY_FOR_PICKUP';
