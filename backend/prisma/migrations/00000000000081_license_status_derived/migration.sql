-- License status is no longer typed in by hand: the API derives it from
-- dueDate (Expired / Renewing within 60 days / Updated), so a stored column
-- could only ever drift from the truth.
ALTER TABLE "import_export_licenses" DROP COLUMN "status";
