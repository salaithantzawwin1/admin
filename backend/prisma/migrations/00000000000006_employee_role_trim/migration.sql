-- =============================================================
-- Phase: Trim EMPLOYEE role permissions (UX + least-privilege)
--
-- Employees only create and track their own requests. They do not
-- browse the org master data or the fleet, so the Fleet, Departments
-- and Employees menus (and their APIs) should not be available to
-- the EMPLOYEE role. Admin/head/management roles keep these.
-- =============================================================

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."roleId" = r.id
  AND rp."permissionId" = p.id
  AND r.name = 'EMPLOYEE'
  AND p.code IN ('org.read', 'fleet.read');
