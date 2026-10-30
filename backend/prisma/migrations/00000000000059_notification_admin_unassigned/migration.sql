-- "Approved but no vehicle at start time" ping to Administration
-- (TripRemindersService.startPassedNudge): the requester already gets the
-- START_PASSED bell, but only Administration can assign a car — so when an
-- APPROVED request passes its start time unassigned, everyone holding
-- cars.assign is told once (in-app + Telegram mirror).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ADMIN_UNASSIGNED';
