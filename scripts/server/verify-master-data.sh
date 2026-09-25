#!/usr/bin/env bash
# =============================================================
# AMS — Master data E2E verify (Plan §6/§7 — vehicle types +
# meeting-room facilities CRUD, runs on the server)
# =============================================================
set -u
BASE=http://127.0.0.1:3000/api

tok() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$1" "$2"; }
uid() { docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM users WHERE username = '$1'\"" | tr -d '\r\n '; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }
SQL() { echo "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA'; }

ATOKEN=$(tok "$(uid admin1)" admin1)        # ADMINISTRATION
ETOKEN=$(tok "$(uid employee1)" employee1)  # EMPLOYEE
STOKEN=$(tok "$(uid sysadmin)" sysadmin)    # SYSTEM_ADMIN

echo "== 1) employee1 cannot manage vehicle types (expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ETOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"E2E_TYPE"}' "$BASE/fleet/vehicle-types"

echo "== 2) admin1 creates vehicle type E2E_TYPE =="
T=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"E2E Type"}' "$BASE/fleet/vehicle-types")
TID=$(echo "$T" | J "j.id")
echo "$T" | J "'name='+j.name+' active='+j.active"

echo "== 3) duplicate type rejected (expect 409) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"E2E_TYPE"}' "$BASE/fleet/vehicle-types"

echo "== 4) hide type (PATCH active=false) =="
curl -s -X PATCH -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"active":false}' "$BASE/fleet/vehicle-types/$TID" | J "'active='+j.active"

echo "== 5) admin1 creates facility E2E Facility =="
F=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"E2E Facility"}' "$BASE/meeting-rooms/facilities")
FID=$(echo "$F" | J "j.id")
echo "$F" | J "'name='+j.name+' active='+j.active"

echo "== 6) sysadmin can also manage facilities =="
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"E2E Facility 2"}' "$BASE/meeting-rooms/facilities" | J "'name='+j.name"

echo "== 7) room with facility via CSV still works (create + list) =="
R=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"E2E Room","capacity":10,"facilities":"E2E Facility, TV"}' "$BASE/meeting-rooms/setup")
RID=$(echo "$R" | J "j.id")
echo "$R" | J "'facilities='+j.facilities"

echo "== 8) facility in use → delete blocked (expect 409) =="
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/meeting-rooms/facilities/$FID"

echo "== 9) audit logs recorded =="
SQL "SELECT action FROM audit_logs WHERE action LIKE 'VEHICLE_TYPE%' OR action LIKE 'FACILITY%' ORDER BY \"createdAt\" DESC LIMIT 4"

echo "== 10) cleanup =="
curl -s -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/meeting-rooms/setup/$RID" | head -c 40; echo
curl -s -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/meeting-rooms/facilities/$FID" | head -c 40; echo
SQL "SELECT id FROM facilities WHERE name='E2E Facility 2'" | tr -d ' ' | while read -r id; do
  [ -n "$id" ] && curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/meeting-rooms/facilities/$id"
done
curl -s -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/fleet/vehicle-types/$TID" | head -c 40; echo
SQL "SELECT 'types_left='||COUNT(*) FROM vehicle_types WHERE name='E2E_TYPE'"
SQL "SELECT 'fac_left='||COUNT(*) FROM facilities WHERE name LIKE 'E2E%'"
SQL "SELECT 'rooms_left='||COUNT(*) FROM meeting_rooms WHERE name='E2E Room'"
echo "DONE"
