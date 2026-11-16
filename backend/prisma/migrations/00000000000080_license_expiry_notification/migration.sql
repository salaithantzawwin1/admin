-- Notification type for the import/export license reminder sweep (60/30 days).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LICENSE_EXPIRY';
