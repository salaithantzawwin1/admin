-- Company Import/Export license register (replaces the Airtable
-- "Export Import License" sheet): one row per company licence carrying the
-- registration dates, the portal logins kept on file and the certificate
-- scans (up to five pictures, see license_images).

CREATE TABLE "import_export_licenses" (
    "id"               UUID         NOT NULL,
    "name"             VARCHAR(160) NOT NULL,
    "registrationNo"   VARCHAR(60),
    "companyLimited"   VARCHAR(200),
    "myanmarName"      VARCHAR(200),
    "startDate"        DATE,
    "dueDate"          DATE,
    "email"            VARCHAR(160),
    "emailPassword"    VARCHAR(160),
    "tradenetPassword" VARCHAR(160),
    "status"           VARCHAR(40)  NOT NULL DEFAULT 'Updated',
    "note"             VARCHAR(500),
    "createdById"      UUID,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_export_licenses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "import_export_licenses_dueDate_idx" ON "import_export_licenses"("dueDate");
CREATE INDEX "import_export_licenses_name_idx" ON "import_export_licenses"("name");

-- Scans live on the volume (UPLOAD_PATH/license-images); the row only keeps
-- the generated file name, which never leaves the server.
CREATE TABLE "license_images" (
    "id"          UUID         NOT NULL,
    "licenseId"   UUID         NOT NULL,
    "storedName"  TEXT         NOT NULL,
    "mimeType"    VARCHAR(40)  NOT NULL,
    "size"        INTEGER      NOT NULL,
    "sortOrder"   INTEGER      NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "license_images_licenseId_idx" ON "license_images"("licenseId");

ALTER TABLE "license_images"
  ADD CONSTRAINT "license_images_licenseId_fkey"
  FOREIGN KEY ("licenseId") REFERENCES "import_export_licenses"("id") ON DELETE CASCADE;

-- ---------- permissions ----------
INSERT INTO "permissions" ("id", "code", "description") VALUES
  (gen_random_uuid(), 'licenses.read', 'View the import/export license register'),
  (gen_random_uuid(), 'licenses.manage', 'Add, edit and delete licenses (reveals the stored portal logins)')
ON CONFLICT ("code") DO NOTHING;

-- ---------- role grants (Administration + SYSTEM_ADMIN) ----------
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.code IN ('licenses.read', 'licenses.manage')
WHERE r.name IN ('ADMINISTRATION', 'SYSTEM_ADMIN')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );
