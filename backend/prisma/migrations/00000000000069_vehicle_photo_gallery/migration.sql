-- Vehicle photos become a gallery: several pictures per section (vehicle,
-- registration, other documents), ordered by sortOrder. The one-row-per-kind
-- unique index is replaced by a plain lookup index.
DROP INDEX "vehicle_photos_vehicleId_kind_key";

ALTER TABLE "vehicle_photos" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "vehicle_photos_vehicleId_kind_idx" ON "vehicle_photos"("vehicleId", "kind");
