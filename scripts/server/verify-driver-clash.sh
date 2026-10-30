#!/usr/bin/env bash
# Driver-clash E2E (TESTING stack, 127.0.0.1:3011):
#   Trip 1 (-30m → +30m) + Trip 2 (+90m → +120m) both assigned to one driver,
#   Trip 1 dispatched, then:
#     D. ⏰ ETA +120m runs into Trip 2      → warning + driverClash flag
#     E. assign Trip 3 (overlaps Trip 2)    → refused by the assign guard
#     F. reassign Trip 3 to the same driver → refused by the reassign guard
#     G. startTrip Trip 2 while Trip 1 is STARTED (overrun) → refused by dispatch re-check
# Cleans up every row it created.
set -u
BASE=http://127.0.0.1:3011/api
DB='docker exec -i ams-test-db-1 psql -U ams -d ams -tA'
q() { printf '%s\n' "$1" | $DB | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }
iso() { date -u -d "$1" +%Y-%m-%dT%H:%M:00Z; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
AIDU=$(q "SELECT id FROM users WHERE username='admin1'")
ATOKEN=$(TOKEN_OF "$AIDU" admin1)

DRV=$(q "SELECT id FROM drivers WHERE status='AVAILABLE' ORDER BY name LIMIT 1")
DRVNAME=$(q "SELECT name FROM drivers WHERE id='$DRV'")
DRV2=$(q "SELECT id FROM drivers WHERE status='AVAILABLE' AND id<>'$DRV' ORDER BY name LIMIT 1")
DRV2NAME=$(q "SELECT name FROM drivers WHERE id='$DRV2'")
VEHS=$(q "SELECT string_agg(id::text, ',') FROM (SELECT id,\"vehicleNo\" FROM vehicles WHERE status='AVAILABLE' ORDER BY \"vehicleNo\" LIMIT 3) x")
V1=$(printf '%s' "$VEHS" | cut -d, -f1); V2=$(printf '%s' "$VEHS" | cut -d, -f2); V3=$(printf '%s' "$VEHS" | cut -d, -f3)
MI1=$(q "SELECT \"currentMileage\" FROM vehicles WHERE id='$V1'"); MI1=${MI1:-0}
MI2=$(q "SELECT \"currentMileage\" FROM vehicles WHERE id='$V2'"); MI2=${MI2:-0}
echo "driver=$DRVNAME · backup=$DRV2NAME · vehicles=$(q "SELECT string_agg(\"vehicleNo\",',') FROM vehicles WHERE id IN ('$V1','$V2','$V3')")"

make_trip() { # name start end -> "id doc"
  local body=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
    -d "{\"destination\":\"$1\",\"startDate\":\"$2\",\"endDate\":\"$3\",\"purpose\":\"driver clash e2e\",\"passengers\":2}" "$BASE/cars/requests")
  local rid=$(printf '%s' "$body" | J "j.id"); local doc=$(printf '%s' "$body" | J "j.docNumber")
  curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$rid/submit" >/dev/null
  curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' -d '{"comment":"e2e"}' "$BASE/requests/$rid/approve" >/dev/null
  printf '%s %s' "$rid" "$doc"
}
assign() { curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"vehicleId\":\"$2\",\"driverId\":\"$3\"}" "$BASE/cars/requests/$1/assign"; }

read -r R1 D1DOC <<< "$(make_trip 'Trip 1 overrun' "$(iso '-30 min')" "$(iso '+30 min')")"
read -r R2 D2DOC <<< "$(make_trip 'Trip 2 next'   "$(iso '+90 min')" "$(iso '+120 min')")"
read -r R3 D3DOC <<< "$(make_trip 'Trip 3 extra'  "$(iso '+100 min')" "$(iso '+150 min')")"
# Trip 4 stays UNASSIGNED so the assign guard itself can be exercised (assign
# only works on an APPROVED request, so it cannot reuse Trip 3)
read -r R4 D4DOC <<< "$(make_trip 'Trip 4 clash'  "$(iso '+100 min')" "$(iso '+150 min')")"
echo "1. requests: $D1DOC $D2DOC $D3DOC $D4DOC"

assign "$R1" "$V1" "$DRV" >/dev/null
assign "$R2" "$V2" "$DRV" >/dev/null
assign "$R3" "$V3" "$DRV2" >/dev/null
echo "2. assigned: $D1DOC+$D2DOC → $DRVNAME · $D3DOC → $DRV2NAME"

echo "3. start $D1DOC → $(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"startMileage\":$MI1}" "$BASE/cars/requests/$R1/trip/start" | J "(j.id?'trip started':j.message)")"

ETA=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"minutes":120}' "$BASE/cars/requests/$R1/eta")
echo "4. ⏰ ETA +120m on $D1DOC → clash flagged: $(printf '%s' "$ETA" | J "j.driverClash?j.driverClash.docNumber:'none'") (expect $D2DOC)"

echo "5. assign $D4DOC to $DRVNAME (overlaps $D2DOC) → $(assign "$R4" "$V3" "$DRV" | J "j.message||'ASSIGNED (guard missing!)'")"
echo "6. reassign $D3DOC to $DRVNAME → $(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"vehicleId\":\"$V3\",\"driverId\":\"$DRV\"}" "$BASE/cars/requests/$R3/reassign" | J "j.message||'REASSIGNED (guard missing!)'")"
echo "7. start $D2DOC while $D1DOC is still STARTED → $(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"startMileage\":$MI2}" "$BASE/cars/requests/$R2/trip/start" | J "j.message||'DISPATCHED (re-check missing!)'")"
echo "8. audit flags: $(q "SELECT count(*) FROM audit_logs WHERE action='CAR_ETA_SET' AND \"recordId\"::text='$R1' AND \"newValue\"::text LIKE '%$D2DOC%'") ETA-row(s) naming $D2DOC"

echo "=== cleanup ==="
for R in "$R1" "$R2" "$R3" "$R4"; do
  q "DELETE FROM car_trips WHERE \"assignmentId\" IN (SELECT id FROM car_assignments WHERE \"requestId\"='$R')" >/dev/null
  q "DELETE FROM notifications WHERE \"requestId\"::text='$R'" >/dev/null
  q "DELETE FROM audit_logs WHERE \"recordId\"::text='$R'" >/dev/null
  q "DELETE FROM car_assignments WHERE \"requestId\"='$R'" >/dev/null
  q "DELETE FROM car_requests WHERE \"requestId\"='$R'" >/dev/null
  q "DELETE FROM approval_actions WHERE \"requestId\"='$R'" >/dev/null
  q "DELETE FROM request_documents WHERE id='$R'" >/dev/null
done
q "UPDATE vehicles SET status='AVAILABLE' WHERE id IN ('$V1','$V2','$V3')" >/dev/null
q "UPDATE drivers SET status='AVAILABLE' WHERE id IN ('$DRV','$DRV2')" >/dev/null
echo "cleanup done · health: $(curl -s -o /dev/null -w '%{http_code}' $BASE/health)"
echo "=== DONE ==="
