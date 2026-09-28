#!/bin/bash
# Run on 192.168.100.110 — E2E smoke for Shared Trips (convoy mode), testing stack.
#   1. plain assign of an overlapping second request FAILS with the booked message
#   2. the same assign with share=true SUCCEEDS and stamps the same sharedTripId group
#   3. panel API exposes the shared badge (sharedRiders on both members)
#   4. availability check for a group member no longer reports its peer as a conflict
#   5. cancelling one member clears its stamp; the other keeps the group
# Actors: head1 creates+submits both requests, sysadmin approves/assigns/acks.
set -e
BASE=http://127.0.0.1:3011/api
ADB="docker exec ams-test-db-1 psql -U ams -d ams -tAc"

tok() {
  local ID; ID=$($ADB "SELECT id FROM users WHERE username='$1' LIMIT 1" | tr -d '\r\n')
  docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$ID" "$1"
}
TOK_A=$(tok sysadmin) # superuser: approve, assign
TOK_R=$(tok head1)    # requester: create + submit

mkreq() { # mkreq <dest> <start+06:30> <end+06:30> → id
  local RES RID
  RES=$(curl -s -X POST -H "Authorization: Bearer $TOK_R" -H 'Content-Type: application/json' \
    -d '{"destination":"'"$1"'","startDate":"'"$2"'","endDate":"'"$3"'","passengers":1,"timeSlot":"CUSTOM_HOURS"}' \
    "$BASE/cars/requests")
  RID=$(echo "$RES" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
  [ -n "$RID" ] || { echo "FAIL — create failed: $RES"; exit 1; }
  curl -s -X POST -H "Authorization: Bearer $TOK_R" "$BASE/requests/$RID/submit" > /dev/null
  curl -s -X POST -H "Authorization: Bearer $TOK_A" -H 'Content-Type: application/json' -d '{"comment":"e2e"}' "$BASE/requests/$RID/approve" > /dev/null
  echo "$RID"
}

ST=$(date -u -d '+2 day' +%Y-%m-%d)
echo "== 1. two overlapping approved requests =="
R1=$(mkreq "E2E shared A" "$ST"'T04:15:00+06:30' "$ST"'T05:15:00+06:30')
R2=$(mkreq "E2E shared B" "$ST"'T04:45:00+06:30' "$ST"'T05:45:00+06:30')
DOC1=$($ADB "SELECT \"docNumber\" FROM request_documents WHERE id='$R1'" | tr -d '\r\n')
DOC2=$($ADB "SELECT \"docNumber\" FROM request_documents WHERE id='$R2'" | tr -d '\r\n')
echo "created+approved $DOC1 ($R1) and $DOC2 ($R2)"
cleanup() { for RID in "$R2" "$R1"; do curl -s -X DELETE -H "Authorization: Bearer $TOK_R" "$BASE/requests/$RID" > /dev/null; done; }
trap cleanup EXIT

echo "== 2. assign A (car+driver) =="
VID=$($ADB "SELECT id FROM vehicles WHERE status='AVAILABLE' LIMIT 1" | tr -d '\r\n')
DID=$($ADB "SELECT id FROM drivers WHERE status='AVAILABLE' LIMIT 1" | tr -d '\r\n')
curl -s -X POST -H "Authorization: Bearer $TOK_A" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VID\",\"driverId\":\"$DID\"}" "$BASE/cars/requests/$R1/assign" > /dev/null
S1=$($ADB "SELECT status FROM request_documents WHERE id='$R1'" | tr -d '\r\n')
echo "A after assign: $S1 (expect IN_PROGRESS)"
[ "$S1" = "IN_PROGRESS" ] || { echo "FAIL — A not assigned"; exit 1; }

echo "== 3. plain assign of B must FAIL (overlap) =="
ERR=$(curl -s -X POST -H "Authorization: Bearer $TOK_A" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VID\",\"driverId\":\"$DID\"}" "$BASE/cars/requests/$R2/assign")
echo "$ERR" | head -c 140; echo
echo "$ERR" | grep -q "already booked" || { echo "FAIL — plain overlap assign did not throw"; exit 1; }

echo "== 4. share=true assign of B must SUCCEED =="
curl -s -X POST -H "Authorization: Bearer $TOK_A" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VID\",\"driverId\":\"$DID\",\"share\":true}" "$BASE/cars/requests/$R2/assign" | head -c 80; echo
S2=$($ADB "SELECT status FROM request_documents WHERE id='$R2'" | tr -d '\r\n')
echo "B after shared assign: $S2 (expect IN_PROGRESS)"
[ "$S2" = "IN_PROGRESS" ] || { echo "FAIL — shared assign failed"; exit 1; }

G1=$($ADB "SELECT \"sharedTripId\" FROM car_requests WHERE \"requestId\"='$R1'" | tr -d '\r\n')
G2=$($ADB "SELECT \"sharedTripId\" FROM car_requests WHERE \"requestId\"='$R2'" | tr -d '\r\n')
[ -n "$G1" ] && [ "$G1" = "$G2" ] && echo "sharedTripId group stamped on both ✓" || { echo "FAIL — group mismatch: '$G1' vs '$G2'"; exit 1; }

echo "== 5. panel API shows the shared badge on both =="
for RID in "$R1" "$R2"; do
  PEERS=$(curl -s -H "Authorization: Bearer $TOK_A" "$BASE/cars/requests/$RID" | grep -o '"sharedRiders":\[[^]]*' | grep -c docNumber || true)
  [ "$PEERS" -ge 1 ] && echo "  $RID sees riders ✓" || { echo "FAIL — no sharedRiders on $RID"; exit 1; }
done

echo "== 6. availability for a group member ignores its peer =="
# window = B's planned window (peer still IN_PROGRESS inside it); caller = B's own id
AV=$(curl -s -H "Authorization: Bearer $TOK_A" "${BASE}/cars/availability?vehicleId=${VID}&startDate=${ST}T22:15:00.000Z&endDate=${ST}T23:45:00.000Z&excludeRequestId=${R2}")
echo "$AV" | head -c 200; echo
echo "$AV" | grep -q '"available":true' && echo "peer no longer blocks ✓" || { echo "FAIL — peer still reported as conflict: $AV"; exit 1; }

echo "== 7. cancel one member; other keeps the group =="
curl -s -X POST -H "Authorization: Bearer $TOK_A" -H 'Content-Type: application/json' -d '{"comment":"e2e shared cleanup"}' "$BASE/cars/requests/$R2/admin-cancel" > /dev/null
GC=$($ADB "SELECT \"sharedTripId\" FROM car_requests WHERE \"requestId\"='$R2'" | tr -d '\r\n')
[ "$GC" = "" ] && echo "cancelled member stamp cleared ✓" || { echo "FAIL — cancelled member kept group: $GC"; exit 1; }
G1B=$($ADB "SELECT \"sharedTripId\" FROM car_requests WHERE \"requestId\"='$R1'" | tr -d '\r\n')
[ "$G1B" = "$G1" ] && echo "surviving member keeps group ✓" || { echo "FAIL — survivor lost group: '$G1B'"; exit 1; }

echo "PASS — Shared Trips E2E OK (cleanup: A deleted; B cancelled in-flow)"
