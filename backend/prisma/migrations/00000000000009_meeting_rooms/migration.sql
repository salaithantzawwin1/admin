-- AMS Phase 7 — meeting rooms + meeting room requests (car-request style flow)

-- CreateEnum
CREATE TYPE "MeetingRoomStatus" AS ENUM ('AVAILABLE', 'IN_USE', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE');

-- Alter existing enums for meeting-room flow
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MEETING_ROOM_ASSIGNED';

-- CreateTable
CREATE TABLE "meeting_rooms" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 8,
    "facilities" TEXT,
    "status" "MeetingRoomStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_room_requests" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "attendees" INTEGER NOT NULL DEFAULT 1,
    "roomId" UUID,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_room_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meeting_rooms_name_key" ON "meeting_rooms"("name");
CREATE UNIQUE INDEX "meeting_room_requests_requestId_key" ON "meeting_room_requests"("requestId");
CREATE INDEX "meeting_room_requests_startTime_endTime_idx" ON "meeting_room_requests"("startTime", "endTime");

-- AddForeignKey
ALTER TABLE "meeting_room_requests" ADD CONSTRAINT "meeting_room_requests_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "request_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meeting_room_requests" ADD CONSTRAINT "meeting_room_requests_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "meeting_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RBAC: meeting-rooms.assign for room assignment (mirror cars.assign)
INSERT INTO "permissions" ("id", "code", "description")
SELECT gen_random_uuid(), 'meeting-rooms.assign', 'Assign rooms to approved meeting requests'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "code" = 'meeting-rooms.assign');

-- ADMINISTRATION gets the new permission
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.code = 'meeting-rooms.assign'
WHERE r.name = 'ADMINISTRATION'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );

-- SYSTEM_ADMIN gets everything new
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.code = 'meeting-rooms.assign'
WHERE r.name = 'SYSTEM_ADMIN'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );

-- Seed default meeting rooms
INSERT INTO "meeting_rooms" ("id", "name", "location", "capacity", "facilities", "updatedAt")
VALUES
  (gen_random_uuid(), 'Meeting Room A', 'Head Office — 2nd Floor', 10, 'TV, Whiteboard, Conference phone', now()),
  (gen_random_uuid(), 'Meeting Room B', 'Head Office — 2nd Floor', 6, 'TV, Whiteboard', now()),
  (gen_random_uuid(), 'Board Room', 'Head Office — 5th Floor', 20, 'Projector, Conference phone, AC', now())
ON CONFLICT ("name") DO NOTHING;
