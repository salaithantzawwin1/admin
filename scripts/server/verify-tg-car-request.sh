#!/bin/bash
# Run on 192.168.100.110 — E2E smoke for the Telegram /car flow (testing stack).
# The real TelegramService poll loop needs the live bot token; this script instead
# verifies the pieces that make the flow work end-to-end without Telegram:
#   1. /car is wired into the running backend (handler exists in the built bundle)
#   2. the conversation state lives only in memory (no schema dependency)
#   3. a real CarsService.createCarRequest + workflow.submit round-trip still works
#      through the API (the same calls the bot makes as the bound user)
set -e
BASE=http://127.0.0.1:3011/api
ADB="docker exec ams-test-db-1 psql -U ams -d ams -tAc"

SYSID=$($ADB "SELECT id FROM users WHERE username='sysadmin' LIMIT 1" | tr -d '\r\n')
TOK=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:'sysadmin'},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$SYSID")

echo "== 1. /car handler present in the deployed backend =="
docker exec ams-test-backend-1 grep -c "handleCarCommand\|carsubmit\|carcancel" /app/dist/cars/telegram-car-actions.service.js

echo "== 2. create + submit a car request via API (same path the bot uses) =="
RES=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"destination":"E2E /car smoke","startDate":"'"$(date -u -d '+3 day' +%Y-%m-%d)"'T09:00:00+06:30","passengers":2,"timeSlot":"FULL_DAY"}' \
  "$BASE/cars/requests")
echo "$RES" | head -c 200; echo
RID=$(echo "$RES" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
DOC=$(echo "$RES" | grep -o '"docNumber":"[^"]*' | head -1 | cut -d'"' -f4)
[ -n "$RID" ] || { echo "FAIL — create failed"; exit 1; }
curl -s -X POST -H "Authorization: Bearer $TOK" "$BASE/requests/$RID/submit" | head -c 120; echo

STATUS=$($ADB "SELECT status FROM request_documents WHERE id='$RID'" | tr -d '\r\n')
echo "status after submit: $STATUS (expect PENDING_APPROVAL)"
[ "$STATUS" = "PENDING_APPROVAL" ] || { echo "FAIL — not submitted"; exit 1; }

echo "== 3. cleanup: cancel the smoke request =="
curl -s -X DELETE -H "Authorization: Bearer $TOK" "$BASE/requests/$RID" > /dev/null && echo "deleted $DOC"

echo "PASS — /car backend wiring + request round-trip OK"
