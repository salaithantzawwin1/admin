-- Announcements notify via the notifications table — extend the enum
-- (migration 24 created the announcement tables; the notification type was missed)
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT';
