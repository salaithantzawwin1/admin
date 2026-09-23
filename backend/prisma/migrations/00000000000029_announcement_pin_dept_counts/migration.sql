-- Announcements: admin can pin a notice to the top of every list (EMERGENCY /
-- all-hands use case). Pinned ordering happens in listAll/listMine.
ALTER TABLE "announcements" ADD COLUMN "pinnedAt" TIMESTAMP(3);

CREATE INDEX "announcements_pinnedAt_idx" ON "announcements"("pinnedAt");

-- Member counts per department — used by the announcement form to warn when a
-- target department has no members (empty-Finance blind spot).
DROP VIEW IF EXISTS "department_member_counts";
CREATE VIEW "department_member_counts" AS
SELECT d.id AS "departmentId", COUNT(e.id)::int AS "memberCount"
FROM "departments" d
LEFT JOIN "employees" e ON e."departmentId" = d.id
GROUP BY d.id;
