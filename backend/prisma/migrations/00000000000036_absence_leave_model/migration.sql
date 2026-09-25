-- =============================================================
-- Phase: Company Time Table + Driver Absence leave model
--
-- Absences become leave entries: FULL day, or HALF day limited to the
-- Morning / Evening half defined by the company timetable (Settings →
-- Company Time Table). The concrete clock window is derived from the
-- timetable at write time; existing columns "startsAt"/"endsAt" remain
-- the source of truth consumed by pickers, cron and clash checks.
-- =============================================================

ALTER TABLE "driver_absences" ADD COLUMN "dayType" TEXT NOT NULL DEFAULT 'FULL';     -- FULL | HALF
ALTER TABLE "driver_absences" ADD COLUMN "period" TEXT NOT NULL DEFAULT 'FULL_DAY';   -- FULL_DAY | MORNING | EVENING

-- Backfill: existing rows were recorded with explicit datetimes — classify
-- them against their own window so the UI can show a sensible period.
UPDATE "driver_absences"
SET "period" = CASE
  WHEN "startsAt"::time >= '12:00' THEN 'EVENING'
  WHEN "endsAt"::time   <= '13:00' THEN 'MORNING'
  ELSE 'FULL_DAY'
END,
"dayType" = CASE
  WHEN ("startsAt"::time >= '12:00') OR ("endsAt"::time <= '13:00') THEN 'HALF'
  ELSE 'FULL'
END;
