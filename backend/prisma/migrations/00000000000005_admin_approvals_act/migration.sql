-- =============================================================
-- Phase: Grant approvals.act to ADMINISTRATION (Plan §4/§5b fix)
--
-- The CAR_REQUEST workflow uses ADMINISTRATION as its L1 approver
-- (seed.js), but the RBAC seed did not grant approvals.act to that
-- role, so Administration users had no Pending Approvals menu and
-- could not see submitted car requests. Any approver role must hold
-- approvals.act.
-- =============================================================

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.code = 'approvals.act'
WHERE r.name = 'ADMINISTRATION'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );
