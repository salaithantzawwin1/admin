#!/usr/bin/env bash
# =============================================================
# AMS — Employee ↔ User link CRUD E2E verify (runs on the server)
# Covers: link existing user → duplicate 409 → unlink → unlink 400 →
#         rename sync → audit trail → cleanup
# =============================================================
set -u
BASE=http://127.0.0.1:3000/api

PGU=$(docker exec ams-test-db-1 printenv POSTGRES_USER)
PGD=$(docker exec ams-test-db-1 printenv POSTGRES_DB)
# psql runs directly (no sh -c nesting) so quoted identifiers in $1 survive
q() { docker exec ams-test-db-1 psql -U "$PGU" -d "$PGD" -tAc "$1" | tr -d '\r\n '; }

tok() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$1" "$2"; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }

SA=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' AND u.status='ACTIVE' LIMIT 1")
SAT=$(tok "$SA" sysadmin)
EMP=$(q "SELECT id FROM employees WHERE \"userId\" IS NULL AND status='ACTIVE' ORDER BY \"createdAt\" DESC LIMIT 1")

echo "== 0) fixture: standalone user without employee =="
U=$(curl -s -X POST -H "Authorization: Bearer $SAT" -H 'Content-Type: application/json' -d '{"username":"e2e_linkuser","password":"Password123","fullName":"E2E Link User","roles":["EMPLOYEE"]}' "$BASE/users")
TUID=$(echo "$U" | J "j.id")
echo "emp=$EMP user=$TUID"

echo "== 1) link existing user (expect username + roles) =="
curl -s -X POST -H "Authorization: Bearer $SAT" -H 'Content-Type: application/json' -d "{\"userId\":\"$TUID\"}" "$BASE/org/employees/$EMP/login" | J "'username='+j.username+' roles='+j.roles.join(',')"

echo "== 2) link again (expect 409) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $SAT" -H 'Content-Type: application/json' -d "{\"userId\":\"$TUID\"}" "$BASE/org/employees/$EMP/login"

echo "== 3) unlink (expect success:true) =="
curl -s -X DELETE -H "Authorization: Bearer $SAT" "$BASE/org/employees/$EMP/login" | J "'success='+j.success+' user='+j.username"

echo "== 4) unlink again (expect 400) =="
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Bearer $SAT" "$BASE/org/employees/$EMP/login"

echo "== 5) re-link + rename employee → user name follows (expect E2E Renamed Person) =="
curl -s -X POST -H "Authorization: Bearer $SAT" -H 'Content-Type: application/json' -d "{\"userId\":\"$TUID\"}" "$BASE/org/employees/$EMP/login" >/dev/null
curl -s -X PATCH -H "Authorization: Bearer $SAT" -H 'Content-Type: application/json' -d '{"fullName":"E2E Renamed Person"}' "$BASE/org/employees/$EMP" >/dev/null
q "SELECT \"fullName\" FROM users WHERE id='$TUID'"

echo "== 6) unlink keeps the account (expect standalone on users table) =="
curl -s -X DELETE -H "Authorization: Bearer $SAT" "$BASE/org/employees/$EMP/login" | J "'success='+j.success"
q "SELECT 'still_exists='||COUNT(*) FROM users WHERE id='$TUID'"

echo "== 7) audit trail (LINKED / UNLINKED) =="
q "SELECT action FROM audit_logs WHERE action LIKE 'EMPLOYEE_LOGIN%' ORDER BY \"createdAt\" DESC LIMIT 4"

echo "== 8) cleanup =="
curl -s -o /dev/null -w 'user_del=%{http_code}\n' -X DELETE -H "Authorization: Bearer $SAT" "$BASE/users/$TUID"
q "SELECT 'emp_name_restored_check='||\"fullName\" FROM employees WHERE id='$EMP'"
docker exec ams-test-db-1 psql -U "$PGU" -d "$PGD" -c "DELETE FROM audit_logs WHERE \"newValue\"::text LIKE '%e2e_linkuser%' OR \"oldValue\"::text LIKE '%e2e_linkuser%'" >/dev/null
echo DONE
