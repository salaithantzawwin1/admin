#!/bin/bash
# Run on 192.168.100.110 — live driver-status lifecycle E2E on the TESTING stack
# (:8030 UI, backend loopback :3011). Scenario the user asked to verify:
#   driver takes Morning Half Day leave
#     → ON_LEAVE during the configured morning window (immediately when recording)
#     → AVAILABLE again right after the window's End Time (5-min status-sync cron)
#     → visible again to assign pickers (active-absence filter drops out).
# Uses a throwaway short morning window (End = now + 2 min) so the whole cycle
# finishes in ~2–7 minutes. Restores the default timetable and deletes the test absence.
set -e
BASE=http://127.0.0.1:3011/api
ADB="docker exec ams-test-db-1 psql -U ams -d ams -tAc"

SYSID=$($ADB "SELECT id FROM users WHERE username='sysadmin' LIMIT 1" | tr -d '\r\n')
TOK=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:'sysadmin'},process.env.JWT_SECRET,{expiresIn:'25m'}))" "$SYSID")
DID=$($ADB "SELECT id FROM drivers WHERE status='AVAILABLE' ORDER BY \"createdAt\" LIMIT 1" | tr -d '\r\n')
DNAME=$($ADB "SELECT name FROM drivers WHERE id='$DID'" | tr -d '\r\n')
[ -n "$DID" ] || { echo "FAIL: no AVAILABLE driver on testing stack"; exit 1; }
TODAY=$(TZ=Asia/Yangon date +%F)
ENDTIME=$(TZ=Asia/Yangon date -d '+2 minutes' +%H:%M)

picker_view() {
  # what GET /fleet/drivers exposes to assign pickers for this driver
  curl -s -H "Authorization: Bearer $TOK" "$BASE/fleet/drivers" \
    | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s).find(x=>x.id===process.argv[1]);console.log(d?JSON.stringify({name:d.name,status:d.status,activeAbsences:(d.absences||[]).length}):'driver-not-in-list')})" "$DID"
}

echo "Driver under test: $DNAME — Morning half-day on $TODAY, morning End Time = $ENDTIME (now+2min)"

echo "== 1. save timetable with a short morning window =="
curl -s -X PUT -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"fullStart\":\"08:00\",\"fullEnd\":\"17:30\",\"morningStart\":\"00:00\",\"morningEnd\":\"$ENDTIME\",\"eveningStart\":\"12:30\",\"eveningEnd\":\"17:30\",\"workDays\":[1,2,3,4,5]}" \
  "$BASE/settings/timetable" | head -c 300; echo

echo "== 2. record Morning half-day leave =="
RES=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"driverId\":\"$DID\",\"date\":\"$TODAY\",\"dayType\":\"HALF\",\"period\":\"MORNING\",\"reason\":\"lifecycle e2e\"}" \
  "$BASE/fleet/absences")
echo "$RES" | head -c 400; echo
AID=$(echo "$RES" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
[ -n "$AID" ] || { echo "FAIL: absence not created"; exit 1; }

ST=$($ADB "SELECT status FROM drivers WHERE id='$DID'" | tr -d '\r\n')
echo "driver status right after recording leave: $ST (expect ON_LEAVE)"
[ "$ST" = "ON_LEAVE" ] || { echo "FAIL: driver not ON_LEAVE during window"; exit 1; }

echo "== 3. assign-picker view while window active =="
picker_view

echo "== 4. wait for End Time + 5-min status-sync cron (poll every 20s, max ~9min) =="
for i in $(seq 1 27); do
  sleep 20
  ST=$($ADB "SELECT status FROM drivers WHERE id='$DID'" | tr -d '\r\n')
  echo "  t+$((i*20))s driver status: $ST"
  [ "$ST" = "AVAILABLE" ] && break
done
[ "$ST" = "AVAILABLE" ] || { echo "FAIL: driver never restored to AVAILABLE"; exit 1; }

echo "== 5. assign-picker view after End Time (expect activeAbsences: 0) =="
picker_view

echo "== 6. cleanup: delete test absence + restore default timetable =="
curl -s -X DELETE -H "Authorization: Bearer $TOK" "$BASE/fleet/absences/$AID"; echo
curl -s -X PUT -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"fullStart":"08:00","fullEnd":"17:30","morningStart":"08:00","morningEnd":"12:30","eveningStart":"12:30","eveningEnd":"17:30","workDays":[1,2,3,4,5]}' \
  "$BASE/settings/timetable" | head -c 300; echo

echo "PASS — $DNAME: ON_LEAVE during morning window → AVAILABLE after End Time → assign-ready"
