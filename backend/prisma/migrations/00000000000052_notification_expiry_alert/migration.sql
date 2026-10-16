-- VMS Phase A (Vehicle spec §6.3/§6.4): document-expiry alerting
-- 1) dedicated notification type for expiry reminders
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VEHICLE_DOC_EXPIRY';
-- 2) dedup key — document + expiry date + threshold + recipient; the daily
--    sweep inserts at most once per key, so reruns can never double-send
ALTER TABLE "notifications" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");
