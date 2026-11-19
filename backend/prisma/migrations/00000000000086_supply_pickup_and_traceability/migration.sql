-- Supply hand-over accountability, stale-pickup reminders, and the
-- OSR → PR → PO → GRN traceability link.

-- The 85 migration created office_supply_requests without the unique index the
-- schema declares on requestId; the FK below needs it.
CREATE UNIQUE INDEX IF NOT EXISTS "office_supply_requests_requestId_key"
  ON "office_supply_requests"("requestId");

ALTER TABLE "office_supply_requests"
  ADD COLUMN "handedOverByName" TEXT,
  ADD COLUMN "receivedByName" TEXT,
  ADD COLUMN "receivedConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "lastReminderAt" TIMESTAMP(3);

ALTER TABLE "purchase_requests"
  ADD COLUMN "sourceSupplyRequestId" UUID;

CREATE INDEX "purchase_requests_sourceSupplyRequestId_idx"
  ON "purchase_requests"("sourceSupplyRequestId");

ALTER TABLE "purchase_requests"
  ADD CONSTRAINT "purchase_requests_sourceSupplyRequestId_fkey"
  FOREIGN KEY ("sourceSupplyRequestId") REFERENCES "office_supply_requests"("requestId")
  ON DELETE SET NULL ON UPDATE CASCADE;
