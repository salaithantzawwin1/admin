-- 🛣️ Persisted odometer capture (P8/P7).
--
-- The capture used to live only in the bot's in-memory map, so a deploy or a
-- restart threw away a photo the driver had already sent (CAR-202611-0023 lost
-- its return reading that way). The columns below hold the capture on the
-- assignment itself: which stage is waiting, the kept photo file name (under
-- uploads/odometer/pending), the Telegram file id for the audit trail, and the
-- number when the driver types it BEFORE the photo (kept, never discarded).
ALTER TABLE "car_assignments"
  ADD COLUMN "pendingOdoStage" TEXT,
  ADD COLUMN "pendingOdoPhoto" TEXT,
  ADD COLUMN "pendingOdoFileId" TEXT,
  ADD COLUMN "pendingOdoKm" INTEGER,
  ADD COLUMN "pendingOdoAt" TIMESTAMP(3);
