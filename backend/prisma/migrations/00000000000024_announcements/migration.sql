-- =============================================================
-- Phase: Administration Announcements (Plan v3.0 §18)
-- =============================================================

CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishAt" TIMESTAMP(3),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "requiresAck" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "announcement_targets" (
    "id" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "targetLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_targets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "announcement_reads" (
    "id" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackAt" TIMESTAMP(3),

    CONSTRAINT "announcement_reads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "announcements_code_key" ON "announcements"("code");
CREATE INDEX "announcements_status_publishAt_idx" ON "announcements"("status", "publishAt");
CREATE INDEX "announcements_category_idx" ON "announcements"("category");
CREATE INDEX "announcement_targets_announcementId_idx" ON "announcement_targets"("announcementId");
CREATE UNIQUE INDEX "announcement_reads_announcementId_userId_key" ON "announcement_reads"("announcementId", "userId");

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Plan §18: tracking is for important notices
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_priority_check"
  CHECK ("priority" IN ('NORMAL','IMPORTANT','URGENT','EMERGENCY'));
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_category_check"
  CHECK ("category" IN ('GENERAL','OFFICE','FACILITY','TRANSPORT','MEETING_ROOM','MAINTENANCE','SAFETY','HOLIDAY','IT','EMERGENCY','OTHER'));
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_type_check"
  CHECK ("targetType" IN ('ALL','DEPARTMENT','ROLE','EMPLOYEE','BRANCH'));
