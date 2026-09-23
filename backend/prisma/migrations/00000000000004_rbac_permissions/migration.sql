-- =============================================================
-- Phase: RBAC fine-grained permissions (Plan §4/§5)
-- =============================================================

CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey"
  FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed permission catalog (codes must match backend PERMISSIONS)
INSERT INTO "permissions" ("id", "code", "description") VALUES
  (gen_random_uuid(), 'users.read',        'View user accounts'),
  (gen_random_uuid(), 'users.manage',      'Create/edit users, roles, reset passwords'),
  (gen_random_uuid(), 'org.read',          'View branches, departments, employees'),
  (gen_random_uuid(), 'org.manage',        'Manage branches, departments, employees'),
  (gen_random_uuid(), 'requests.read.own', 'View own requests'),
  (gen_random_uuid(), 'requests.read.all', 'View all requests (admin view)'),
  (gen_random_uuid(), 'requests.create',   'Create and submit requests'),
  (gen_random_uuid(), 'approvals.act',     'Act on pending approvals'),
  (gen_random_uuid(), 'workflow.manage',   'Configure workflows and delegations admin'),
  (gen_random_uuid(), 'fleet.read',        'View vehicles and drivers'),
  (gen_random_uuid(), 'fleet.manage',      'Manage vehicles and drivers'),
  (gen_random_uuid(), 'cars.assign',       'Assign vehicles/drivers and manage trips'),
  (gen_random_uuid(), 'audit.read',        'View audit logs'),
  (gen_random_uuid(), 'attachments.use',   'Upload and download attachments');

-- Role permission matrix
-- SYSTEM_ADMIN: everything
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r CROSS JOIN "permissions" p WHERE r.name = 'SYSTEM_ADMIN';

-- ADMINISTRATION: org manage, fleet, cars, requests read all
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.code IN (
  'org.read','org.manage','fleet.read','fleet.manage','cars.assign',
  'requests.read.all','requests.read.own','requests.create','attachments.use'
) WHERE r.name = 'ADMINISTRATION';

-- MANAGEMENT: read org, read all requests, audit
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.code IN (
  'org.read','requests.read.all','requests.read.own','requests.create',
  'fleet.read','approvals.act','audit.read','attachments.use'
) WHERE r.name = 'MANAGEMENT';

-- DEPARTMENT_HEAD: approve, read org, own requests
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.code IN (
  'org.read','requests.read.own','requests.create','approvals.act',
  'fleet.read','attachments.use'
) WHERE r.name = 'DEPARTMENT_HEAD';

-- PURCHASING: own requests + org read
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.code IN (
  'org.read','requests.read.own','requests.create','attachments.use'
) WHERE r.name = 'PURCHASING';

-- FINANCE: read-only
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.code IN (
  'org.read','requests.read.all','requests.read.own','fleet.read','attachments.use'
) WHERE r.name = 'FINANCE';

-- MAINTENANCE_COORDINATOR: fleet + org read
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.code IN (
  'org.read','fleet.read','fleet.manage','cars.assign',
  'requests.read.own','requests.create','attachments.use'
) WHERE r.name = 'MAINTENANCE_COORDINATOR';

-- EMPLOYEE: own requests only
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.code IN (
  'requests.read.own','requests.create','org.read','fleet.read','attachments.use'
) WHERE r.name = 'EMPLOYEE';
