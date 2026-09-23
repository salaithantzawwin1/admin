#!/usr/bin/env bash
# =============================================================
# AMS — grant a permission code to roles (idempotent, run on the server)
# Usage: bash grant-permission.sh <code> <ROLE1> [ROLE2...]
# =============================================================
set -eu
CODE="$1"; shift
PGU=$(docker exec ams-db-1 printenv POSTGRES_USER)
PGD=$(docker exec ams-db-1 printenv POSTGRES_DB)
for ROLE in "$@"; do
  docker exec ams-db-1 psql -U "$PGU" -d "$PGD" -v code="$CODE" -v role="$ROLE" <<'SQL'
INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = :'role' AND p.code = :'code'
ON CONFLICT DO NOTHING;
SQL
  echo "granted $CODE -> $ROLE"
done
docker exec ams-db-1 psql -U "$PGU" -d "$PGD" -tAc "SELECT r.name FROM role_permissions rp JOIN roles r ON r.id=rp.\"roleId\" JOIN permissions p ON p.id=rp.\"permissionId\" WHERE p.code='$CODE' ORDER BY r.name"
