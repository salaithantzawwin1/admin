-- license_images.sortOrder never earned its place: there is no drag-to-reorder
-- UI, so the column only stored the upload count. Pictures are ordered by
-- createdAt, the same order the gallery always showed.
ALTER TABLE "license_images" DROP COLUMN "sortOrder";
