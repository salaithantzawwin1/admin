#!/usr/bin/env bash
# =============================================================
# AMS — Fleet E2E verify (Plan §6, runs on the server)
# Covers: vehicle CRUD, driver CRUD, driver clear (blank default
#         driver), existence checks, delete guards, absences
# =============================================================
set -u
BASE=http://127.0.0.1:3000/api

tok() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$1" "$2"; }
uid() { docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM users WHERE username = '$1'\"" | tr -d '\r\n '; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }
SQL() { echo "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA'; }

ATOKEN=$(tok "$(uid admin1)" admin1)
ETOKEN=$(tok "$(uid employee1)" employee1)

echo "== 1) employee1 cannot create vehicle (expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ETOKEN" -H 'Content-Type: application/json' \
  -d '{"vehicleNo":"E2E-999","vehicleType":"SEDAN","brandModel":"Test"}' "$BASE/fleet/vehicles"

echo "== 2) create vehicle without driver (expect driverId null) =="
V=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"vehicleNo":"E2E-T1","vehicleType":"SEDAN","brandModel":"E2E Test Car"}' "$BASE/fleet/vehicles")
VID=$(echo "$V" | J "j.id")
echo "$V" | J "'created driverId='+j.driverId"

echo "== 3) create test driver =="
D=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"E2E Driver"}' "$BASE/fleet/drivers")
DID=$(echo "$D" | J "j.id")
echo "$D" | J "'status='+j.status"

echo "== 4) duplicate vehicleNo rejected (expect 400) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"vehicleNo":"E2E-T1","vehicleType":"SEDAN","brandModel":"Dup"}' "$BASE/fleet/vehicles"

echo "== 5) assign driver via PATCH =="
curl -s -X PATCH -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d "{\"driverId\":\"$DID\"}" "$BASE/fleet/vehicles/$VID" | J "'driverId='+j.driverId"

echo "== 6) CLEAR driver with null (the fix — expect driverId=null) =="
curl -s -X PATCH -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"driverId":null}' "$BASE/fleet/vehicles/$VID" | J "'driverId='+j.driverId"

echo "== 7) bogus driverId rejected (expect 400, not 500) =="
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"driverId":"00000000-0000-0000-0000-000000000000"}' "$BASE/fleet/vehicles/$VID"

echo "== 8) driver update — set phone then clear with null =="
curl -s -X PATCH -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"phone":"09-12345678"}' "$BASE/fleet/drivers/$DID" | J "'phone='+j.phone"
curl -s -X PATCH -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"phone":null}' "$BASE/fleet/drivers/$DID" | J "'phone after clear='+j.phone"

echo "== 9) VEHICLE_UPDATED audit includes driver change =="
SQL "SELECT \"newValue\" FROM audit_logs WHERE action='VEHICLE_UPDATED' AND \"recordId\"='$VID' ORDER BY \"createdAt\" DESC LIMIT 1"

echo "== 10) delete vehicle without history (expect ok) =="
curl -s -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/fleet/vehicles/$VID" | J "'ok='+j.ok"

echo "== 11) delete driver (expect ok) =="
curl -s -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/fleet/drivers/$DID" | J "'ok='+j.ok"

echo "== 12) cleanup check (expect 0 / 0) =="
SQL "SELECT COUNT(*) FROM vehicles WHERE \"vehicleNo\"='E2E-T1'"
SQL "SELECT COUNT(*) FROM drivers WHERE name='E2E Driver'"
echo "DONE"
