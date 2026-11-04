-- Vehicle pictures: the car itself (PHOTO), its registration certificate
-- (REGISTRATION) and one other document (DOCUMENT). One picture per kind; the
-- file lives in UPLOAD_PATH/vehicle-photos (mode 0600) and is only ever served
-- through the permission-guarded /fleet/vehicles/:id/photos/:kind route.
CREATE TABLE "vehicle_photos" (
    "id" TEXT NOT NULL,
    "vehicleId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_photos_pkey" PRIMARY KEY ("id")
);

-- one row per vehicle + kind (uploading again replaces the picture)
CREATE UNIQUE INDEX "vehicle_photos_vehicleId_kind_key" ON "vehicle_photos"("vehicleId", "kind");

ALTER TABLE "vehicle_photos" ADD CONSTRAINT "vehicle_photos_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
