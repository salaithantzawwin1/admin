-- WINDOW_ENDING notification type: T-15 "trip ending soon" bell (requester copy
-- and the no-Telegram driver copy) — see TripRemindersService.endingSoonNudge
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WINDOW_ENDING';
