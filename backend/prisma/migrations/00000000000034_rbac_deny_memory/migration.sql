-- =============================================================
-- Phase: RBAC deny-memory — deliberate matrix revocations survive restarts
--
-- Bug this fixes: seedPermissions() (permissions-seed.ts) is grant-only; every
-- backend restart re-inserted DEFAULT_GRANTS codes that an admin had unticked
-- in the RBAC matrix (e.g. suppliers.read for FINANCE). Denies silently
-- resurrected on every redeploy.
--
-- Fix: role_permissions_denied records role/code pairs that a matrix save
-- deliberately dropped; the seeder skips them. Re-granting from the matrix
-- deletes the deny row (grant wins). FINANCE × suppliers.read is seeded here
-- so the currently-deployed deny (set via the matrix, then wiped by restarts)
-- is restored as permanent memory.
-- =============================================================

CREATE TABLE "role_permissions_denied" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permissions_denied_pkey" PRIMARY KEY ("roleId","permissionId")
);

ALTER TABLE "role_permissions_denied" ADD CONSTRAINT "role_permissions_denied_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions_denied" ADD CONSTRAINT "role_permissions_denied_permissionId_fkey"
  FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the deployed denies: this environment unticked suppliers.read for
-- FINANCE in the RBAC matrix. Record it so no restart can re-grant it.
INSERT INTO "role_permissions_denied" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r.name = 'FINANCE'
  AND p.code = 'suppliers.read'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );
