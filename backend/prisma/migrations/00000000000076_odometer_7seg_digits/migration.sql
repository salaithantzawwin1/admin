-- 🔢 Offline seven-segment odometer reader (docs/ODOMETER_OCR_PLAN.md).
--
-- These two tables ARE the classifier: every row of odometer_digit_samples is a
-- digit glyph cut from a photo an administrator labelled, and every row of
-- odometer_lcd_calibrations records where the ODO digit row sat inside the
-- instrument cluster on that photo. No model files, no key, no internet.
CREATE TABLE "odometer_digit_samples" (
    "id" UUID NOT NULL,
    "digit" TEXT NOT NULL,
    "patch" TEXT NOT NULL,
    "vehicleNo" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odometer_digit_samples_pkey" PRIMARY KEY ("id")
);

-- classifying a glyph scans its own digit's templates only
CREATE INDEX "odometer_digit_samples_digit_idx" ON "odometer_digit_samples"("digit");

CREATE TABLE "odometer_lcd_calibrations" (
    "id" UUID NOT NULL,
    "assignmentId" UUID,
    "stage" TEXT,
    "vehicleNo" TEXT,
    "rx" DOUBLE PRECISION NOT NULL,
    "ry" DOUBLE PRECISION NOT NULL,
    "rw" DOUBLE PRECISION NOT NULL,
    "rh" DOUBLE PRECISION NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odometer_lcd_calibrations_pkey" PRIMARY KEY ("id")
);

-- "has this photo already been labelled?" for the training queue
CREATE INDEX "odometer_lcd_calibrations_assignmentId_stage_idx" ON "odometer_lcd_calibrations"("assignmentId", "stage");
