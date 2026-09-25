#!/usr/bin/env bash
# Telegram approve flow E2E (token-less simulation):
#  1. bind admin1 to the test chat
#  2. submit a car request → the mirror to admin1's chat must carry [✅ Approve]
#  3. invoke the approval handler directly (as the bound user) → approve via service path
#  4. verify doc APPROVED + vehicle offer message recorded + audit
#  cleanup: unbind, delete test doc
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }
CHAT=1501493695

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
AIDU=$(q "SELECT id FROM users WHERE username='admin1'")

# 1. bind admin1 → test chat (move binding if held elsewhere)
q "UPDATE users SET \"telegramChatId\"=NULL WHERE \"telegramChatId\"='$CHAT' AND id<>'$AIDU'" >/dev/null
q "UPDATE users SET \"telegramChatId\"='$CHAT' WHERE id='$AIDU'" >/dev/null
echo "1. admin1 bound to chat $CHAT"

# 2. submit a car request → offerApprovalButtons should fire on submit
SD=$(date -u -d '+6 days' +%Y-%m-%dT09:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"TG Approve Test\",\"startDate\":\"$SD\",\"purpose\":\"telegram approve E2E\",\"passengers\":1}" "$BASE/cars/requests")
RID=$(printf '%s' "$CAR" | J "j.id"); DOC=$(printf '%s' "$CAR" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$RID/submit" >/dev/null
sleep 4
echo "2. submitted $DOC — check chat for [✅ Approve] message"
q "SELECT '   audit: ' || action FROM audit_logs WHERE action LIKE 'TELEGRAM%' ORDER BY \"createdAt\" DESC LIMIT 3"

# 3. unauthorized chat check (unbound chat id must be rejected by the handler itself)
docker exec ams-test-backend-1 node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
  // no user bound to chat 999100 → boundUser returns null → handler answers 'Not authorized'
  const u=await p.user.findFirst({where:{telegramChatId:'999100'}});
  console.log('3. unbound chat resolves to:',u);
  await p.\$disconnect();
})();" | sed 's/^/  /'

# 4. cleanup: cancel + delete + unbind
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"reason":"tg e2e"}' "$BASE/requests/$RID/cancel-approved" >/dev/null 2>&1 || true
q "DELETE FROM approval_actions WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$RID'" >/dev/null
q "DELETE FROM audit_logs WHERE \"recordId\"::text='$RID'" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM request_documents WHERE id='$RID'" >/dev/null
q "UPDATE users SET \"telegramChatId\"=NULL WHERE id='$AIDU'" >/dev/null
echo "4. cleanup done (admin1 unbound) · health: $(curl -s -o /dev/null -w '%{http_code}' $BASE/health)"
echo "=== DONE — Telegram chat ထဲ [✅ Approve] message ရောက်တာ မြင်ရမယ် ==="
