-- Attachments generalize: announcements can carry files too (Plan §18)
ALTER TABLE "attachments" ADD COLUMN "announcementId" UUID;

CREATE INDEX "attachments_announcementId_idx" ON "attachments"("announcementId");

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_announcementId_fkey"
  FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
