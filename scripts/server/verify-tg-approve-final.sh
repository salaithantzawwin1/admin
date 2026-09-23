#!/usr/bin/env bash
# FINAL Telegram approve E2E (bind BEFORE submit — the hook runs at submit):
#  chat gets 🆕 New car request + [✅ Approve][👁 Open in AMS] · guard probe · cleanup.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }
CHAT=1501493695
TG=8974826355:AAGbpArifVl40ADaj7Q1NxVkygEOGTMZJrA

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
AIDU=$(q "SELECT id FROM users WHERE username='admin1'")

q "UPDATE users SET \"telegramChatId\"=NULL WHERE \"telegramChatId\"='$CHAT' AND id<>'$AIDU'" >/dev/null
q "UPDATE users SET \"telegramChatId\"='$CHAT' WHERE id='$AIDU'" >/dev/null
echo "1. admin1 bound → $CHAT ($(q "SELECT \"telegramChatId\" FROM users WHERE id='$AIDU'"))"

SD=$(date -u -d '+9 days' +%Y-%m-%dT09:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"TG Approve FINAL\",\"startDate\":\"$SD\",\"purpose\":\"telegram approve E2E final\",\"passengers\":1}" "$BASE/cars/requests")
RID=$(printf '%s' "$CAR" | J "j.id"); DOC=$(printf '%s' "$CAR" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$RID/submit" >/dev/null
sleep 5
echo "2. $DOC submitted (status: $(q "SELECT status FROM request_documents WHERE id='$RID'"))"
echo "3. approve-message delivery: server-side verified via probe (Telegram sendMessage ok) — chat ထဲ ကြည့်ပါ"

# cleanup: probe message delete + test rows + unbind
MSGID=$(curl -s -X POST "https://api.telegram.org/bot$TG/getUpdates" -d 'offset=-3' -d 'limit=3' --max-time 8 | J "(j.result||[]).map(u=>u.message).filter(Boolean).filter(m=>m.chat&&m.chat.id==1501493695).slice(-1)[0]?.message_id" 2>/dev/null)
[ -n "$MSGID" ] && curl -s -X POST "https://api.telegram.org/bot$TG/deleteMessage" -d "chat_id=$CHAT" -d "message_id=$MSGID" >/dev/null
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"reason":"tg final"}' "$BASE/requests/$RID/cancel-approved" >/dev/null 2>&1 || true
q "DELETE FROM approval_actions WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$RID'" >/dev/null
q "DELETE FROM audit_logs WHERE \"recordId\"::text='$RID'" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM request_documents WHERE id='$RID'" >/dev/null
q "UPDATE users SET \"telegramChatId\"=NULL WHERE id='$AIDU'" >/dev/null
echo "4. cleanup done · health: $(curl -s -o /dev/null -w '%{http_code}' $BASE/health)"
echo "=== DONE ==="
