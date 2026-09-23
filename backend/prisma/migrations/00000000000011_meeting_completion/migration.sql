-- AMS — meeting completion (Plan §7: Reservation → Meeting → Completed)
-- Track when a meeting was marked complete so the room can be freed reliably.

-- AlterTable
ALTER TABLE "meeting_room_requests" ADD COLUMN "completedAt" TIMESTAMP(3);

-- CreateEnum value for meeting-completed notifications
ALTER TYPE "NotificationType" ADD VALUE 'MEETING_COMPLETED';

-- Existing IN_PROGRESS meetings whose window already ended are completed by the
-- auto-complete pass on next boot; backfill their completedAt for consistency.
UPDATE "meeting_room_requests" SET "completedAt" = "endTime"
WHERE "status" = 'COMPLETED' AND "completedAt" IS NULL;
