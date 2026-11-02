-- §13/§14/§15 — Maintenance management (v3.0).
--
-- MaintenanceRecord is the permanent service-history document for one
-- maintainable unit (Aircon, Generator, UPS, printer…): what broke, what was
-- done, who did it, what it cost, and when the next service is due.
-- MaintenanceSchedule is the preventive side: "every N months" plus the last
-- done / next due pair the dashboard sorts on.
--
-- Cost has ONE home: a record whose parts+labor+other totals more than 0
-- writes a SERVICE row into asset_costs (sourceType = 'MAINTENANCE'), so the
-- asset's total cost of ownership already includes the servicing. The cost*
-- columns here are the breakdown the service sheet keeps; asset_costs is the
-- money the reporting layer reads.

-- CreateTable
CREATE TABLE "maintenance_records" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "assetId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CORRECTIVE',
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "problem" TEXT,
    "workDone" TEXT,
    "vendorId" UUID,
    "technician" TEXT,
    "costParts" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "costLabor" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "costOther" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "downtimeHours" DECIMAL(6,1),
    "warrantyEndDate" TIMESTAMP(3),
    "nextDueDate" TIMESTAMP(3),
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_schedules" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "intervalMonths" INTEGER NOT NULL,
    "lastDoneAt" TIMESTAMP(3),
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_records_code_key" ON "maintenance_records"("code");

-- CreateIndex
CREATE INDEX "maintenance_records_assetId_date_idx" ON "maintenance_records"("assetId", "date");

-- CreateIndex
CREATE INDEX "maintenance_records_nextDueDate_idx" ON "maintenance_records"("nextDueDate");

-- CreateIndex
CREATE INDEX "maintenance_schedules_nextDueAt_idx" ON "maintenance_schedules"("nextDueAt");

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
