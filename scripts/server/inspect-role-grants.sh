#!/bin/bash
# Grant map for planning the employees/departments gate fix
set -e
docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
\pset pager off
SELECT r.name AS role,
  bool_or(p.code='org.read')          AS "org.read",
  bool_or(p.code='org.manage')        AS "org.manage",
  bool_or(p.code='employees.read')    AS "emp.read",
  bool_or(p.code='employees.manage')  AS "emp.manage",
  bool_or(p.code='departments.read')  AS "dept.read",
  bool_or(p.code='departments.manage') AS "dept.manage",
  bool_or(p.code='fleet.manage')      AS "fleet.manage",
  bool_or(p.code='cars.assign')       AS "cars.assign"
FROM roles r
LEFT JOIN role_permissions rp ON rp."roleId" = r.id
LEFT JOIN permissions p ON p.id = rp."permissionId"
GROUP BY r.name ORDER BY r.name;
SQL
