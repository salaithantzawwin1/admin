-- 🔢 Which dashboard a calibration belongs to (docs/ODOMETER_OCR_PLAN.md).
--
-- The ODO row sits in a different place on every instrument cluster, so a row
-- position labelled on one dashboard is not a valid search window on another:
-- it can land straight on the clock or the speedometer numerals. The key is a
-- coarse 32×18 fingerprint of the frame, and the reader only uses calibrations
-- whose key matches the photo it is looking at. No match = a cold full-frame
-- search, never another dashboard's window.
ALTER TABLE "odometer_lcd_calibrations" ADD COLUMN "dashboardKey" TEXT;

CREATE INDEX "odometer_lcd_calibrations_dashboardKey_idx" ON "odometer_lcd_calibrations"("dashboardKey");
