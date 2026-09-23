-- AMS — meeting room request requirement fields (Plan §7)

-- CreateEnum
CREATE TYPE "MeetingType" AS ENUM ('INTERNAL', 'EXTERNAL');

-- AlterTable
ALTER TABLE "meeting_room_requests" ADD COLUMN "meetingType" "MeetingType" NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE "meeting_room_requests" ADD COLUMN "externalCompanies" TEXT;
ALTER TABLE "meeting_room_requests" ADD COLUMN "attendeeNames" TEXT;
ALTER TABLE "meeting_room_requests" ADD COLUMN "itAssist" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "meeting_room_requests" ADD COLUMN "reservedDriver" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "meeting_room_requests" ADD COLUMN "services" TEXT;
