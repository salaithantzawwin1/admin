-- Fuel is bought in litres; the price per litre is derived from amount / litres.
ALTER TABLE "car_expenses" ADD COLUMN "litres" DECIMAL(10,2);

-- Service due by distance, per vehicle (both bounds blank = no reminder).
ALTER TABLE "vehicles"
  ADD COLUMN "serviceIntervalKm" INTEGER,
  ADD COLUMN "lastServiceKm" INTEGER,
  ADD COLUMN "lastServiceAt" TIMESTAMP(3),
  ADD COLUMN "serviceNudgedAt" TIMESTAMP(3);
