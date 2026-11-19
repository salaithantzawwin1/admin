-- Two supply events had no notification type; the values were cast away in the
-- service (which the database would have rejected at insert time anyway).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPLY_COLLECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPLY_PICKUP_REMINDER';
