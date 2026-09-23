-- Driver absences: planned non-availability (leave, training, sickness…)
CREATE TABLE "driver_absences" (
    "id" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_absences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "driver_absences_driverId_startsAt_endsAt_idx" ON "driver_absences"("driverId", "startsAt", "endsAt");

-- AddForeignKey
ALTER TABLE "driver_absences" ADD CONSTRAINT "driver_absences_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Note: createdById intentionally has no FK to users — soft reference for audit display
