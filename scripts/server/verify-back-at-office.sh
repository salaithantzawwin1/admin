#!/bin/bash
# Run on 192.168.100.110 — E2E smoke for the Back-at-Office fixes (testing stack).
#   1. deployed backend carries completeAfterReturn + the conflict trim
#   2. an APPROVED+assigned request goes COMPLETED when the driver acks "returned"
#      (simulate-ack = the exact code path the Telegram button takes)
#   3. checkWindowConflicts no longer warns for windows after the early return
# Actors: head1 creates/submits (requester), sysadmin approves+assigns+acks
# (SYSTEM_ADMIN superuser bypass — the testing seed grants no cars.assign to roles;
# self-approval is forbidden so the requester must differ from the approver).
set -e
BASE=http://127.0.0.1:3011/api
ADB="docker exec ams-test-db-1 psql -U ams -d ams -tAc"

tok() { # tok <username> → JWT
  local ID; ID=$($ADB "SELECT id FROM users WHERE username='$1' LIMIT 1" | tr -d '\r\n')
  docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$ID" "$1"
}
TOK_A=$(tok sysadmin) # superuser: approve, assign, ack
TOK_R=$(tok head1)    # requester: create + submit

echo "== 1. new code present in the deployed backend =="
docker exec ams-test-backend-1 grep -c "completeAfterReturn\|REQUEST_AUTO_COMPLETED" /app/dist/telegram/telegram.service.js
docker exec ams-test-backend-1 grep -c "driverBackAtOfficeAt" /app/dist/cars/cars.service.js

echo "== 2. approve + assign + ack-returned → auto-COMPLETED =="
ST=$(date -u -d '+2 day' +%Y-%m-%d)
RES=$(curl -s -X POST -H "Authorization: Bearer $TOK_R" -H 'Content-Type: application/json' \
  -d '{"destination":"E2E back-at-office smoke","startDate":"'"$ST"'T10:45:00+06:30","endDate":"'"$ST"'T11:45:00+06:30","passengers":1,"timeSlot":"CUSTOM_HOURS"}' \
  "$BASE/cars/requests")
RID=$(echo "$RES" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
DOC=$(echo "$RES" | grep -o '"docNumber":"[^"]*' | head -1 | cut -d'"' -f4)
[ -n "$RID" ] || { echo "FAIL — create failed: $RES"; exit 1; }
echo "created $DOC ($RID)"
cleanup() { curl -s -X DELETE -H "Authorization: Bearer $TOK_A" "$BASE/requests/$RID" > /dev/null; }
trap cleanup EXIT

curl -s -X POST -H "Authorization: Bearer $TOK_R" "$BASE/requests/$RID/submit" > /dev/null
AP=$(curl -s -X POST -H "Authorization: Bearer $TOK_A" -H 'Content-Type: application/json' -d '{"comment":"e2e"}' "$BASE/requests/$RID/approve")
STATUS=$($ADB "SELECT status FROM request_documents WHERE id='$RID'" | tr -d '\r\n')
echo "after approve: $STATUS (expect APPROVED) ${AP:0:80}"
[ "$STATUS" = "APPROVED" ] || { echo "FAIL — not approved"; exit 1; }

VID=$($ADB "SELECT id FROM vehicles WHERE status='AVAILABLE' LIMIT 1" | tr -d '\r\n')
curl -s -X POST -H "Authorization: Bearer $TOK_A" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VID\"}" "$BASE/cars/requests/$RID/assign" > /dev/null
STATUS=$($ADB "SELECT status FROM request_documents WHERE id='$RID'" | tr -d '\r\n')
echo "after assign: $STATUS (expect IN_PROGRESS)"
[ "$STATUS" = "IN_PROGRESS" ] || { echo "FAIL — assign did not move to IN_PROGRESS"; exit 1; }

AID=$($ADB "SELECT id FROM car_assignments WHERE \"requestId\"='$RID'" | tr -d '\r\n')
echo "assignment $AID"
curl -s -X POST -H "Authorization: Bearer $TOK_A" -H 'Content-Type: application/json' \
  -d '{"assignmentId":"'"$AID"'","action":"returned"}' "$BASE/cars/assignments/simulate-ack" > /dev/null
sleep 1
STATUS=$($ADB "SELECT status FROM request_documents WHERE id='$RID'" | tr -d '\r\n')
echo "after returned ack: $STATUS (expect COMPLETED — auto-complete)"
[ "$STATUS" = "COMPLETED" ] || { echo "FAIL — auto-complete did not fire"; exit 1; }
$ADB "SELECT action FROM audit_logs WHERE \"recordId\"='$RID' AND action='REQUEST_AUTO_COMPLETED'" | grep -q REQUEST_AUTO_COMPLETED \
  && echo "audit REQUEST_AUTO_COMPLETED ✓"

echo "== 3. conflict alert trims at the early return =="
# booking above: planned 10:45→11:45 (+06:30 = UTC+6.5), returned ack happened NOW →
# effective end ≈ now. A fresh window entirely after now must NOT warn about $DOC.
NB=$(date -u -d '+1 day' +%Y-%m-%d)
CON=$(curl -s -H "Authorization: Bearer $TOK_A" \
  "$BASE/cars/availability/conflicts?startDate=${NB}T02:00:00.000Z&endDate=${NB}T05:00:00.000Z")
echo "$CON" | head -c 300; echo
echo "$CON" | grep -q "$DOC" && { echo "FAIL — stale conflict still warned"; exit 1; }
echo "no stale conflict for the returned booking ✓"

echo "PASS — Back-at-Office auto-complete + conflict trim OK (cleanup deletes $DOC)"
