-- "Start time passed without approval" bell (TripRemindersService.startPassedNudge):
-- a car request whose scheduled START arrives while approval is still outstanding
-- — or approved with no vehicle ever assigned — tells the requester once,
-- instead of leaving them waiting in silence until the T+24h auto-expiry.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'START_PASSED';
