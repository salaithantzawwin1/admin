-- Planned non-availability of a VEHICLE (service, inspection, repair …).
-- Modeled after driver_absences: Administration blocks a car for a known
-- period; assign/booking flows skip vehicles with an overlapping window and
-- the requester 7-day fleet card shows the window like a booking.
CREATE TABLE "vehicle_unavailabilities" (
    "id"         UUID   NOT NULL,
    "vehicleId"  UUID   NOT NULL,
    "startsAt"   TIMESTAMP(3) NOT NULL,
    "endsAt"     TIMESTAMP(3) NOT NULL,
    "reason"     TEXT,
    "status"     TEXT   NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID  NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_unavailabilities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vehicle_unavailabilities_vehicleId_startsAt_endsAt_idx"
  ON "vehicle_unavailabilities"("vehicleId", "startsAt", "endsAt");

ALTER TABLE "vehicle_unavailabilities"
  ADD CONSTRAINT "vehicle_unavailabilities_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE;
