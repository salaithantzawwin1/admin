#!/bin/bash
# Run on 192.168.100.110: verify prod RBAC with synthetic role-holder users
# (prod DB has no real users yet — create temp ones, probe, then remove).
set -e
BASE=http://127.0.0.1:3000/api
# Production = project "ams" (UI :80, backend loopback :3000)
DB=ams-db-1
BE=ams-backend-1
PH=$(docker exec $DB printenv POSTGRES_PASSWORD)

mkuser() { # $1=username $2=role
docker exec $DB sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"
INSERT INTO users (id, username, \\\"passwordHash\\\", \\\"fullName\\\", status, \\\"updatedAt\\\")
VALUES (gen_random_uuid(), '$1', 'probe-not-a-login', 'Probe $1', 'ACTIVE', now())
ON CONFLICT (username) DO NOTHING;
INSERT INTO user_roles (\\\"userId\\\", \\\"roleId\\\")
SELECT u.id, r.id FROM users u, roles r
WHERE u.username='$1' AND r.name='$2'
ON CONFLICT DO NOTHING;\"" >/dev/null
docker exec $DB sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM users WHERE username='$1'\"" | tr -d '\r\n'
}

rmuser() {
docker exec $DB sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"DELETE FROM users WHERE username='$1'\"" >/dev/null
}

TOKEN=$(docker exec $BE node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'rbac-probe-finance'}, process.env.JWT_SECRET,{expiresIn:'10m'}))" "$(mkuser rbac-probe-finance FINANCE)")
TOKENA=$(docker exec $BE node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'rbac-probe-admin'}, process.env.JWT_SECRET,{expiresIn:'10m'}))" "$(mkuser rbac-probe-admin ADMINISTRATION)")

probe() {
  local label=$1 T=$2
  local s e i d m
  s=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/suppliers")
  e=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/org/employees?pageSize=5")
  i=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/inventory/items")
  d=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/org/departments")
  m=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/auth/permissions/matrix")
  printf '%-22s suppliers=%s employees=%s departments=%s inventory=%s matrix=%s\n' "$label" "$s" "$e" "$d" "$i" "$m"
}

echo "== PROD (synthetic users, real role grants) =="
probe "FINANCE" "$TOKEN"
probe "ADMINISTRATION" "$TOKENA"

rmuser rbac-probe-finance
rmuser rbac-probe-admin
echo "(probes removed)"
