#!/usr/bin/env bash
# Clean up demo trips CAR-202609-0023/0024 + demo testing data:
# cancel both docs (requester), free vehicles/drivers, delete demo Telegram
# messages, unbind the demo driver chat, remove demo notifications.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)

for DOC in CAR-202609-0023 CAR-202609-0024; do
  RID=$(q "SELECT id FROM request_documents WHERE \"docNumber\"='$DOC'")
  if [ -z "$RID" ]; then echo "$DOC: not found (already gone)"; continue; fi
  ST=$(q "SELECT status FROM request_documents WHERE id='$RID'")
  if [ "$ST" = "CANCELLED" ]; then echo "$DOC: already CANCELLED"; else
    R=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
      -d '{"reason":"Demo cleanup"}' "$BASE/requests/$RID/cancel-approved")
    echo "$DOC ($ST) → $(printf '%s' "$R" | head -c 60)"
  fi
done

# demo Telegram messages out of @salaithantzawwin's chat (75 = new-format demo, 64/69 already gone)
for M in 75 69 64; do
  curl -s -X POST "https://api.telegram.org/bot8974826355:AAGbpArifVl40ADaj7Q1NxVkygEOGTMZJrA/deleteMessage" \
    -d 'chat_id=1501493695' -d "message_id=$M" >/dev/null
done
echo "demo messages deleted from chat"

# demo driver binding (U Zaw Zaw was pointed at the test user's chat for the demo)
q "UPDATE drivers SET \"telegramChatId\"=NULL, \"telegramUsername\"=NULL WHERE name='U Zaw Zaw' AND \"telegramChatId\"='1501493695'" >/dev/null
echo "demo driver chat binding removed"

# demo notifications tied to the cancelled docs
q "DELETE FROM notifications WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docNumber\" IN ('CAR-202609-0023','CAR-202609-0024'))" >/dev/null
echo "demo notifications removed"

echo "— final state:"
q "SELECT '  doc ' || \"docNumber\" || ' → ' || status FROM request_documents WHERE \"docNumber\" IN ('CAR-202609-0023','CAR-202609-0024')"
q "SELECT '  vehicle ' || \"vehicleNo\" || ' → ' || status FROM vehicles ORDER BY \"vehicleNo\""
q "SELECT '  driver U Zaw Zaw → ' || status || ' · chat=' || COALESCE(\"telegramChatId\",'—') FROM drivers WHERE name='U Zaw Zaw'"
q "SELECT '  active car assignments: ' || count(*) FROM car_assignments WHERE \"releasedAt\" IS NULL"
q "SELECT '  non-cancelled car docs: ' || count(*) FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%' AND status <> 'CANCELLED'"
echo "=== DONE ==="
