#!/usr/bin/env bash
# Re-run submit test with in-container debug of the Telegram approve hook.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }
CHAT=1501493695

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
AIDU=$(q "SELECT id FROM users WHERE username='admin1'")
q "UPDATE users SET \"telegramChatId\"=NULL WHERE \"telegramChatId\"='$CHAT' AND id<>'$AIDU'" >/dev/null
q "UPDATE users SET \"telegramChatId\"='$CHAT', status='ACTIVE' WHERE id='$AIDU'" >/dev/null
echo "admin1 (id $AIDU) bound → chat $CHAT: $(q "SELECT \"telegramChatId\" FROM users WHERE id='$AIDU'")"

SD=$(date -u -d '+7 days' +%Y-%m-%dT09:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"TG Approve 2\",\"startDate\":\"$SD\",\"purpose\":\"telegram approve E2E #2\",\"passengers\":1}" "$BASE/cars/requests")
RID=$(printf '%s' "$CAR" | J "j.id"); DOC=$(printf '%s' "$CAR" | J "j.docNumber")
echo "submitting $DOC ..."
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$RID/submit" >/dev/null
sleep 5
echo "— last audit rows:"
q "SELECT action || ' · ' || left(coalesce(\"newValue\"::text,''),40) FROM audit_logs ORDER BY \"createdAt\" DESC LIMIT 4"
echo "— doc status: $(q "SELECT status FROM request_documents WHERE id='$RID'")"

# cleanup
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"reason":"tg e2e 2"}' "$BASE/requests/$RID/cancel-approved" >/dev/null 2>&1 || true
q "DELETE FROM approval_actions WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$RID'" >/dev/null
q "DELETE FROM audit_logs WHERE \"recordId\"::text='$RID'" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM request_documents WHERE id='$RID'" >/dev/null
q "UPDATE users SET \"telegramChatId\"=NULL WHERE id='$AIDU'" >/dev/null
echo "cleanup done"
echo "=== DONE — chat ထဲ Approve message စစ်ပါ ==="
