-- Odometer readings captured at the driver's "Ready" (departure) and
-- "Back at Office" (return) taps, with the dashboard photo as evidence.
-- Trip usage = endOdoKm - startOdoKm; the monthly per-vehicle total sums them.
ALTER TABLE "car_assignments"
  ADD COLUMN "startOdoKm"    INTEGER,
  ADD COLUMN "startOdoPhoto" TEXT,
  ADD COLUMN "startOdoAt"    TIMESTAMP(3),
  ADD COLUMN "endOdoKm"      INTEGER,
  ADD COLUMN "endOdoPhoto"   TEXT,
  ADD COLUMN "endOdoAt"      TIMESTAMP(3);
