-- 🛣️ OCR cross-check (docs/ODOMETER_OCR_PLAN.md), shadow mode.
--
-- The reader never records a reading: these columns hold what it saw in the
-- driver's photo, so the typed number can be checked against the evidence.
-- odoCheckedAt marks a number that was verified (in shadow mode: counted only).
ALTER TABLE "car_assignments"
  ADD COLUMN "odoReadKm" INTEGER,
  ADD COLUMN "odoReadAt" TIMESTAMP(3),
  ADD COLUMN "odoReadSource" TEXT,
  ADD COLUMN "odoReadConfidence" TEXT,
  ADD COLUMN "odoCheckedAt" TIMESTAMP(3);
