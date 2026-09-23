-- AMS — inventory item images
-- Photos live in the shared uploads volume (uploads_data), same storage the
-- attachments module uses. Only the stored file name is kept on the item row.

ALTER TABLE "inventory_items" ADD COLUMN "imageStoredName" TEXT;
