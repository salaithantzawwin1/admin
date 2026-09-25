#!/bin/bash
# Run on 192.168.100.110: verify RBAC deny-memory deployment state.
set -e
docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
\pset pager off
SELECT migration_name, finished_at IS NOT NULL AS applied
FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 3;

SELECT count(*) AS denied_rows FROM role_permissions_denied;

SELECT r.name AS role, p.code AS denied_code
FROM role_permissions_denied d
JOIN roles r ON r.id = d."roleId"
JOIN permissions p ON p.id = d."permissionId"
ORDER BY r.name, p.code;

-- what the FINANCE role currently holds
SELECT r.name AS role, string_agg(p.code, ', ' ORDER BY p.code) AS permissions
FROM roles r
LEFT JOIN role_permissions rp ON rp."roleId" = r.id
LEFT JOIN permissions p ON p.id = rp."permissionId"
WHERE r.name = 'FINANCE'
GROUP BY r.name;

-- who holds FINANCE
SELECT u.username, u."fullName"
FROM users u
JOIN user_roles ur ON ur."userId" = u.id
JOIN roles r ON r.id = ur."roleId"
WHERE r.name = 'FINANCE';
SQL
