-- Asset -> asset component link: a part (e.g. a toner cartridge) that is its
-- own asset and gets fitted into a machine (e.g. a printer).
CREATE TABLE "asset_installations" (
    "id" UUID NOT NULL,
    "parentAssetId" UUID NOT NULL,
    "componentAssetId" UUID NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "costTransferred" DECIMAL(12,2),
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_installations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asset_installations_parentAssetId_idx" ON "asset_installations"("parentAssetId");
CREATE INDEX "asset_installations_componentAssetId_idx" ON "asset_installations"("componentAssetId");

ALTER TABLE "asset_installations"
    ADD CONSTRAINT "asset_installations_parentAssetId_fkey"
    FOREIGN KEY ("parentAssetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_installations"
    ADD CONSTRAINT "asset_installations_componentAssetId_fkey"
    FOREIGN KEY ("componentAssetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_installations"
    ADD CONSTRAINT "asset_installations_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
