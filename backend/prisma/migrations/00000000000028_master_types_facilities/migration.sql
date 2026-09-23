-- =============================================================
-- Phase: Editable master data — vehicle types + room facilities
-- (Plan §6 Fleet, §7 Meeting Rooms)
-- Administration (Dept_Users) and System Admin can manage both via
-- new permissions; pickers no longer hard-code the lists.
-- Idempotent: safe to re-apply after a rolled-back attempt.
-- =============================================================

-- ---------- master tables ----------
CREATE TABLE IF NOT EXISTS "vehicle_types" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_types_name_key" ON "vehicle_types"("name");

CREATE TABLE IF NOT EXISTS "facilities" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "facilities_name_key" ON "facilities"("name");

-- seed from the hard-coded lists that were in use before
INSERT INTO "vehicle_types" ("id", "name", "updatedAt") VALUES
  (gen_random_uuid(), 'SEDAN', now()),
  (gen_random_uuid(), 'SUV', now()),
  (gen_random_uuid(), 'PICKUP', now()),
  (gen_random_uuid(), 'VAN', now()),
  (gen_random_uuid(), 'BUS', now()),
  (gen_random_uuid(), 'TRUCK', now()),
  (gen_random_uuid(), 'OTHER', now())
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "facilities" ("id", "name", "updatedAt") VALUES
  (gen_random_uuid(), 'TV', now()),
  (gen_random_uuid(), 'Whiteboard', now()),
  (gen_random_uuid(), 'Projector', now()),
  (gen_random_uuid(), 'Conference phone', now()),
  (gen_random_uuid(), 'AC', now()),
  (gen_random_uuid(), 'Video conference', now()),
  (gen_random_uuid(), 'Water dispenser', now())
ON CONFLICT ("name") DO NOTHING;

-- ---------- extend VehicleType enum for runtime-added types ----------
ALTER TYPE "VehicleType" ADD VALUE IF NOT EXISTS 'MINIVAN';
ALTER TYPE "VehicleType" ADD VALUE IF NOT EXISTS 'MINIBUS';
ALTER TYPE "VehicleType" ADD VALUE IF NOT EXISTS 'LIMOUSINE';
ALTER TYPE "VehicleType" ADD VALUE IF NOT EXISTS 'STAFF_BUS';
ALTER TYPE "VehicleType" ADD VALUE IF NOT EXISTS 'VAN_CARGO';

-- ---------- permissions ----------
INSERT INTO "permissions" ("id", "code", "description") VALUES
  (gen_random_uuid(), 'fleet.types.manage', 'Manage vehicle type master data'),
  (gen_random_uuid(), 'meeting-rooms.facilities.manage', 'Manage meeting-room facility master data')
ON CONFLICT ("code") DO NOTHING;

-- ---------- role grants (Administration + SYSTEM_ADMIN) ----------
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.code IN ('fleet.types.manage', 'meeting-rooms.facilities.manage')
WHERE r.name IN ('ADMINISTRATION', 'SYSTEM_ADMIN')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );
