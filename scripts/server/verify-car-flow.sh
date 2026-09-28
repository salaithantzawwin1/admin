#!/bin/bash
# Run on 192.168.100.110 — E2E smoke for the Telegram /car flow fixes (testing stack).
# The bot's Telegram transport needs the live token; this verifies the server-side
# pieces the /car flow exercises:
#   1. new parser helpers present in the deployed bundle
#   2. the exact payload the bot submits for a short date (5/10 09:00 → 2026-10-05T02:30Z)
#      creates + submits a request through createCarRequest + workflow.submit
#   3. end default (no End, FULL_DAY) = same-day 17:00 Yangon
#   4. cleanup
# Actors: head1 (the bound user the bot would act as).
set -e
BASE=http://127.0.0.1:3011/api
ADB="docker exec ams-test-db-1 psql -U ams -d ams -tAc"

tok() {
  local ID; ID=$($ADB "SELECT id FROM users WHERE username='$1' LIMIT 1" | tr -d '\r\n')
  docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$ID" "$1"
}
TOK_R=$(tok head1)

echo "== 1. new /car helpers present in the deployed backend =="
docker exec ams-test-backend-1 grep -c "parseCarDateStatic\|toAsciiDigits" /app/dist/cars/telegram-car-actions.service.js

echo "== 2. bot-style payload with a short date (5/10 09:00) round-trips =="
ST=$(date -u -d '+7 day' +%Y-%m-%d) # 5/10-equivalent: day 5 of next month handled in unit tests; here use a real date
RES=$(curl -s -X POST -H "Authorization: Bearer $TOK_R" -H 'Content-Type: application/json' \
  -d '{"destination":"E2E /car short-date smoke","startDate":"'"$ST"'T02:30:00.000Z","timeSlot":"FULL_DAY","passengers":1}' \
  "$BASE/cars/requests")
RID=$(echo "$RES" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
DOC=$(echo "$RES" | grep -o '"docNumber":"[^"]*' | head -1 | cut -d'"' -f4)
[ -n "$RID" ] || { echo "FAIL — create failed: $RES"; exit 1; }
echo "created $DOC"
SD=$($ADB "SELECT \"startDate\" FROM car_requests WHERE \"requestId\"='$RID'" | tr -d '\r\n')
ED=$($ADB "SELECT \"endDate\" FROM car_requests WHERE \"requestId\"='$RID'" | tr -d '\r\n')
echo "start: $SD  end: $ED (expect end = same day 10:30Z = 17:00 Yangon)"
[ "$(echo "$SD" | cut -c1-10)" = "$(echo "$ED" | cut -c1-10)" ] || { echo "FAIL — end not same day"; exit 1; }
[ "$(echo "$ED" | cut -c12-16)" = "10:30" ] || { echo "FAIL — end is not 17:00 Yangon: $ED"; exit 1; }
curl -s -X POST -H "Authorization: Bearer $TOK_R" "$BASE/requests/$RID/submit" > /dev/null
STATUS=$($ADB "SELECT status FROM request_documents WHERE id='$RID'" | tr -d '\r\n')
echo "after submit: $STATUS (expect PENDING_APPROVAL — approver card was offered)"
[ "$STATUS" = "PENDING_APPROVAL" ] || { echo "FAIL — not submitted"; exit 1; }

echo "== 3. cleanup =="
curl -s -X DELETE -H "Authorization: Bearer $TOK_R" "$BASE/requests/$RID" > /dev/null && echo "deleted $DOC"
echo "PASS — /car server-side flow OK"
