-- Tier 1 vehicle identification & specification data (all optional — legacy rows stay blank)
ALTER TABLE "vehicles" ADD COLUMN "vin" TEXT;
ALTER TABLE "vehicles" ADD COLUMN "fuelType" TEXT;
ALTER TABLE "vehicles" ADD COLUMN "engineNo" TEXT;
ALTER TABLE "vehicles" ADD COLUMN "chassisNo" TEXT;
ALTER TABLE "vehicles" ADD COLUMN "make" TEXT;
ALTER TABLE "vehicles" ADD COLUMN "model" TEXT;
ALTER TABLE "vehicles" ADD COLUMN "year" INTEGER;

-- VIN uniquely identifies a vehicle (17-char serial) — blank/null rows exempt
CREATE UNIQUE INDEX "vehicles_vin_key" ON "vehicles"("vin");
