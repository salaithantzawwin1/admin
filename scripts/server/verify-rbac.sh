#!/usr/bin/env bash
# =============================================================
# AMS — RBAC E2E verify (Plan §4/§5/§5b, runs on the server)
# Covers: guard enforcement (403/200), role→permission matrix,
#         runtime matrix edit (audit-logged), plan-alignment grants
# =============================================================
set -u
BASE=http://127.0.0.1:3000/api

tok() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$1" "$2"; }
uid() { docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM users WHERE username = '$1'\"" | tr -d '\r\n '; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }

ATOKEN=$(tok "$(uid admin1)" admin1)        # ADMINISTRATION + EMPLOYEE
ETOKEN=$(tok "$(uid employee1)" employee1)  # EMPLOYEE
STOKEN=$(tok "$(uid sysadmin)" sysadmin)    # SYSTEM_ADMIN (superuser)

echo "== 1) admin1 reads inventory (inventory.read, expect 200) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/items"

echo "== 2) admin1 spending report (inventory.manage via ADMINISTRATION, expect 200) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/spending"

echo "== 3) employee1 spending report (expect 403 — not granted) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ETOKEN" "$BASE/inventory/spending"

echo "== 4) employee1 announcements (announcements.read, expect 200) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ETOKEN" "$BASE/announcements/mine"

echo "== 5) admin1 permission matrix (no users.read, expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ATOKEN" "$BASE/auth/permissions/matrix"

echo "== 6) sysadmin matrix — catalog size + plan-alignment grants =="
M=$(curl -s -H "Authorization: Bearer $STOKEN" "$BASE/auth/permissions/matrix")
echo "$M" | J "'catalog='+j.catalog.length"
echo "$M" | J "'PURCHASING announcements.read = '+j.roles.find(r=>r.role==='PURCHASING').permissions.includes('announcements.read')"
echo "$M" | J "'FINANCE announcements.read = '+j.roles.find(r=>r.role==='FINANCE').permissions.includes('announcements.read')"
echo "$M" | J "'SYSTEM_ADMIN locked full = '+(j.roles.find(r=>r.role==='SYSTEM_ADMIN').permissions.length===j.catalog.length)"

echo "== 7) runtime matrix edit — revoke announcements.read from PURCHASING =="
NEWPERMS=$(echo "$M" | J "JSON.stringify(j.roles.find(r=>r.role==='PURCHASING').permissions.filter(c=>c!=='announcements.read'))")
curl -s -X PATCH -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' \
  -d "{\"permissions\":$NEWPERMS}" "$BASE/auth/permissions/roles/PURCHASING" | J "'saved='+j.success"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/auth/permissions/matrix" | J "'after revoke = '+j.roles.find(r=>r.role==='PURCHASING').permissions.includes('announcements.read')"

echo "== 8) restore (grant back) =="
curl -s -X PATCH -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' \
  -d "{\"permissions\":$(echo "$M" | J "JSON.stringify(j.roles.find(r=>r.role==='PURCHASING').permissions)")}" \
  "$BASE/auth/permissions/roles/PURCHASING" | J "'restored='+j.success"

echo "== 9) SYSTEM_ADMIN role edit blocked =="
curl -s -X PATCH -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' \
  -d '{"permissions":["audit.read"]}' "$BASE/auth/permissions/roles/SYSTEM_ADMIN" | J "'blocked='+(!j.success)"

echo "== 10) matrix edits audit-logged =="
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT action FROM audit_logs WHERE module='RBAC' ORDER BY \\\"createdAt\\\" DESC LIMIT 2\""

echo "== 11) unknown role edit (expect success=false) =="
curl -s -X PATCH -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' \
  -d '{"permissions":[]}' "$BASE/auth/permissions/roles/NO_SUCH_ROLE" | J "'handled='+(!j.success)"

echo "== 12) permissions persist in DB (final state) =="
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT r.name||' => '||COUNT(p.code) FROM roles r JOIN \\\"role_permissions\\\" rp ON rp.\\\"roleId\\\"=r.id JOIN permissions p ON p.id=rp.\\\"permissionId\\\" WHERE r.name IN ('PURCHASING','FINANCE') GROUP BY r.name ORDER BY r.name\""

echo "== 13) suppliers.read/manage — admin1 (expect 200 / 200) =="
curl -s -o /dev/null -w 'list=%{http_code}\n' -H "Authorization: Bearer $ATOKEN" "$BASE/suppliers"
SID=$(docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM suppliers LIMIT 1"' | tr -d '\r\n ')
curl -s -o /dev/null -w 'history=%{http_code}\n' -H "Authorization: Bearer $ATOKEN" "$BASE/suppliers/$SID/history"

echo "== 14) employee1 suppliers list (expect 403 — no suppliers.read) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ETOKEN" "$BASE/suppliers"

echo "== 15) employee1 contact-log write (expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ETOKEN" -H 'Content-Type: application/json' \
  -d '{"summary":"should be blocked"}' "$BASE/suppliers/$SID/contact-logs"

echo "== 16) suppliers codes — seeded grants per role =="
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT r.name||': '||string_agg(p.code, ',' ORDER BY p.code) FROM roles r JOIN role_permissions rp ON rp.\"roleId\"=r.id JOIN permissions p ON p.id=rp.\"permissionId\" WHERE p.code LIKE 'suppliers%' GROUP BY r.name ORDER BY r.name\""
echo "DONE"
