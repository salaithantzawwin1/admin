-- Driver-reported ETA (Telegram ⏰ Delay): when the car is actually expected
-- back. Lives on the assignment (cleared on Back at Office / release) and
-- extends the booking's effective end = max(endDate, estimatedReturnAt) for
-- the fleet card, conflict pre-warning and availability checks.
ALTER TABLE "car_assignments" ADD COLUMN "estimatedReturnAt" TIMESTAMP(3);
