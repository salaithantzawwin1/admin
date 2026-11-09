-- Follow-up throttle: when Administration was last told that a closed trip has
-- no odometer reading yet (at most one nudge a day per assignment).
ALTER TABLE "car_assignments" ADD COLUMN "odoNudgeAt" TIMESTAMP(3);
