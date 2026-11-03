-- Asset photo: one picture per asset, stored in UPLOAD_PATH/asset-photos and
-- served only through the permission-guarded /assets/:id/photo route.
ALTER TABLE "assets" ADD COLUMN "photoStoredName" TEXT,
                     ADD COLUMN "photoMime" TEXT,
                     ADD COLUMN "photoSize" INTEGER,
                     ADD COLUMN "photoUpdatedAt" TIMESTAMP(3);
