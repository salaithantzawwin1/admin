#!/bin/bash
# Inspect: who holds org.read, where does myothiri's access come from
set -e
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
\pset pager off
-- all roles holding org.read
SELECT r.name AS role
FROM role_permissions rp
JOIN roles r ON r.id = rp."roleId"
JOIN permissions p ON p.id = rp."permissionId"
WHERE p.code = 'org.read'
ORDER BY r.name;

-- myothiri's roles
SELECT r.name AS role FROM user_roles ur
JOIN users u ON u.id = ur."userId"
JOIN roles r ON r.id = ur."roleId"
WHERE u.username = 'myothiri' ORDER BY r.name;

-- myothiri effective permissions grouped by granting role
SELECT r.name AS via_role, string_agg(p.code, ', ' ORDER BY p.code) AS grants
FROM user_roles ur
JOIN users u ON u.id = ur."userId"
JOIN roles r ON r.id = ur."roleId"
JOIN role_permissions rp ON rp."roleId" = r.id
JOIN permissions p ON p.id = rp."permissionId"
WHERE u.username = 'myothiri'
GROUP BY r.name ORDER BY r.name;
SQL
