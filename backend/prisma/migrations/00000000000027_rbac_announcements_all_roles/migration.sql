-- =============================================================
-- Phase: RBAC v3.0 alignment — announcements.read for all roles
-- announcements.read is a read-only catalog permission (company
-- notices). PURCHASING and FINANCE were missed when the
-- announcements module shipped (migration 24 grants only reached
-- the roles listed in DEFAULT_GRANTS at that time).
-- =============================================================

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p.code = 'announcements.read'
  AND r.name IN ('PURCHASING', 'FINANCE')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );
