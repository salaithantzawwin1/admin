#!/bin/bash
# Run on 192.168.100.110 — E2E: does a real notification reach an open SSE stream?
# Scenario: subscribe sysadmin to /events → record a driver absence (notifyMany
# to fleet.manage holders incl. sysadmin) → the 'notification' event frame must
# arrive within seconds (not 15s+ polling).
set -e
BASE=http://127.0.0.1:3011/api
ADB="docker exec ams-test-db-1 psql -U ams -d ams -tAc"

SYSID=$($ADB "SELECT id FROM users WHERE username='sysadmin' LIMIT 1" | tr -d '\r\n')
TOK=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:'sysadmin'},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$SYSID")
DID=$($ADB "SELECT id FROM drivers WHERE status='AVAILABLE' ORDER BY \"createdAt\" LIMIT 1" | tr -d '\r\n')
DATE=$(TZ=Asia/Yangon date -d '+2 day' +%F)

echo "== subscribe sysadmin to /events (background, 25s) =="
(timeout 25 curl -sN "$BASE/events?token=$TOK" > /tmp/sse-live.out 2>&1 &)
sleep 2

echo "== trigger: record driver absence (sends notification to fleet.manage holders) =="
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"driverId\":\"$DID\",\"date\":\"$DATE\",\"dayType\":\"FULL\",\"period\":\"FULL_DAY\",\"reason\":\"sse push test\"}" \
  "$BASE/fleet/absences" | head -c 200; echo

echo "== wait up to 8s for the notification frame =="
FOUND=no
for i in $(seq 1 8); do
  sleep 1
  if grep -q 'event: notification' /tmp/sse-live.out; then FOUND=yes; break; fi
done
FRAMES=$(grep -c 'event:' /tmp/sse-live.out || true)
echo "frames received: $FRAMES (found notification event: $FOUND)"
echo "--- stream ---"; cat /tmp/sse-live.out

AID=$($ADB "SELECT id FROM driver_absences WHERE reason='sse push test' ORDER BY \"createdAt\" DESC LIMIT 1" | tr -d '\r\n')
curl -s -X DELETE -H "Authorization: Bearer $TOK" "$BASE/fleet/absences/$AID" > /dev/null
echo "cleanup: test absence deleted"

[ "$FOUND" = "yes" ] && echo "PASS — notification push arrived live on the SSE stream" || { echo "FAIL — no push within 8s"; exit 1; }
