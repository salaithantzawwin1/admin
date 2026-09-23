-- Telegram driver notifications (Plan: car assignment → driver ack flow)
-- Driver: Telegram binding (chat id resolved via /start <bindCode> in the bot chat).
-- CarAssignment: driver ack timestamps — Noted (admin assign acknowledged),
-- Arrived (car ready for requester), Back at Office (vehicle free again).
-- Notification routing: Noted/Back → Administration, Arrived → requester.

ALTER TABLE "drivers" ADD COLUMN "telegramChatId" TEXT;
ALTER TABLE "drivers" ADD COLUMN "telegramBindCode" TEXT;
CREATE UNIQUE INDEX "drivers_telegramBindCode_key" ON "drivers"("telegramBindCode");

ALTER TABLE "car_assignments" ADD COLUMN "driverNotedAt" TIMESTAMP(3);
ALTER TABLE "car_assignments" ADD COLUMN "driverArrivedAt" TIMESTAMP(3);
ALTER TABLE "car_assignments" ADD COLUMN "driverBackAtOfficeAt" TIMESTAMP(3);
ALTER TABLE "car_assignments" ADD COLUMN "telegramMessageId" TEXT;

-- Existing IN_PROGRESS assignments are mid-trip: they were already acknowledged
-- outside Telegram, so backfill Noted to keep cards consistent.
UPDATE "car_assignments" SET "driverNotedAt" = "assignedAt"
WHERE "releasedAt" IS NULL AND "driverNotedAt" IS NULL;

ALTER TYPE "NotificationType" ADD VALUE 'CAR_DRIVER_NOTED';
ALTER TYPE "NotificationType" ADD VALUE 'CAR_DRIVER_ARRIVED';
ALTER TYPE "NotificationType" ADD VALUE 'CAR_DRIVER_RETURNED';
