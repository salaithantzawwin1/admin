-- =============================================================
-- Phase: Trim ADMINISTRATION role permissions (least-privilege)
--
-- Administration (admin1) approves car requests and assigns
-- vehicles/drivers. Requester name + department arrive on the
-- request document itself, so browsing org master data
-- (Departments / Employees) is unnecessary for that role.
-- Car assignment keeps working: the CarPanel reads vehicles and
-- drivers from /fleet/* (fleet.read), not from /org/*.
-- SYSTEM_ADMIN keeps everything via a wildcard grant.
-- =============================================================

DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."roleId" = r.id
  AND rp."permissionId" = p.id
  AND r.name = 'ADMINISTRATION'
  AND p.code IN ('org.read', 'org.manage');
