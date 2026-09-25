-- =============================================================
-- Phase: org.read OR-leg retirement — dedicated read codes now gate
--        /org/employees and /org/departments (RBAC matrix alignment)
--
-- The controllers previously accepted org.read OR employees.read /
-- departments.read. org.read was seeded to 7 roles in migration 04
-- (legacy "view org data" catch-all), so roles with Employees and
-- Departments unticked in the matrix (FINANCE, PURCHASING,
-- MANAGEMENT, DEPARTMENT_HEAD…) still read the employee directory.
--
-- This migration grants the dedicated read codes where the role's
-- intent already implied directory access:
--   • departments.read → roles that legitimately use department
--     pickers (announcement targeting, employee/branch forms)
--   • employees.read   → MAINTENANCE_COORDINATOR (fleet driver picker)
-- FINANCE / PURCHASING / MANAGEMENT / DEPARTMENT_HEAD get nothing:
-- the matrix (both unticked) is the intended state.
-- =============================================================

-- departments.read: roles that need department/branch pickers
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p.code = 'departments.read'
  AND r.name IN ('ADMINISTRATION', 'DEPARTMENT_HEAD', 'MANAGEMENT', 'MAINTENANCE_COORDINATOR', 'PURCHASING')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );

-- employees.read: fleet driver picker (link driver ↔ employee)
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p.code = 'employees.read'
  AND r.name IN ('ADMINISTRATION', 'MAINTENANCE_COORDINATOR')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );
