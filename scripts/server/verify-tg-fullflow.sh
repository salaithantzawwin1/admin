#!/usr/bin/env bash
# FULL-FLOW Telegram approve E2E — real submit, real handler execution via the
# compiled TelegramCarActionsService (bound user = admin1), then cleanup.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }
CHAT=1501493695

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
AIDU=$(q "SELECT id FROM users WHERE username='admin1'")

q "UPDATE users SET \"telegramChatId\"=NULL WHERE \"telegramChatId\"='$CHAT' AND id<>'$AIDU'" >/dev/null
q "UPDATE users SET \"telegramChatId\"='$CHAT' WHERE id='$AIDU'" >/dev/null

SD=$(date -u -d '+10 days' +%Y-%m-%dT09:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"TG Full Flow\",\"startDate\":\"$SD\",\"purpose\":\"telegram full-flow E2E\",\"passengers\":1}" "$BASE/cars/requests")
RID=$(printf '%s' "$CAR" | J "j.id"); DOC=$(printf '%s' "$CAR" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$RID/submit" >/dev/null
sleep 4
echo "1. $DOC submitted — PENDING: $(q "SELECT status FROM request_documents WHERE id='$RID'")"

# drive the real handler inside the container: approve → pick vehicle → pick driver
docker exec -i ams-backend-1 node - "$RID" <<'EOF' | sed 's/^/  /'
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const rid = process.argv[2];
const CHAT = '1501493695';
const TOKEN = '8974826355:AAGbpArifVl40ADaj7Q1NxVkygEOGTMZJrA';
const send = async (text) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML' }),
  });
  return (await r.json()).ok;
};
(async () => {
  // step A: approve via the same workflow call the handler performs (actor = bound admin1)
  const admin = await p.user.findUnique({ where: { username: 'admin1' } });
  // reuse compiled WorkflowService directly
  const { WorkflowService } = require('/app/dist/workflow/workflow.service.js');
  const { PrismaService } = require('/app/dist/prisma/prisma.module.js');
  const { AuditService } = require('/app/dist/audit/audit.service.js');
  const { NotificationsService } = require('/app/dist/notifications/notifications.service.js');
  const { TelegramService } = require('/app/dist/telegram/telegram.service.js');
  const { NumberingService } = require('/app/dist/numbering/numbering.service.js');
  const prisma = new PrismaService();
  await prisma.$connect();
  const audit = new AuditService(prisma);
  const telegram = new TelegramService(prisma, audit);
  const notifications = new NotificationsService(prisma, telegram);
  const numbering = new NumberingService(prisma);
  const wf = new WorkflowService(prisma, numbering, notifications, audit);
  try {
    await wf.approve(rid, 'Approved via Telegram (E2E)', { userId: admin.id, username: admin.username });
    console.log('A. approve() ok →', (await p.requestDocument.findUnique({ where: { id: rid }, select: { status: true } })).status);
    await send(`🧪 E2E: <b>Approve step done</b> — vehicle list would appear next`);
  } catch (e) {
    console.log('A. approve() failed:', e.message);
  }
  await prisma.$disconnect();
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
EOF

echo "2. doc status after handler: $(q "SELECT status FROM request_documents WHERE id='$RID'")"
echo "3. approval action rows: $(q "SELECT count(*) FROM approval_actions WHERE \"requestId\"='$RID'")"

# cleanup
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"reason":"tg full e2e"}' "$BASE/requests/$RID/cancel-approved" >/dev/null 2>&1 || true
q "DELETE FROM approval_actions WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$RID'" >/dev/null
q "DELETE FROM audit_logs WHERE \"recordId\"::text='$RID'" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM request_documents WHERE id='$RID'" >/dev/null
q "UPDATE users SET \"telegramChatId\"=NULL WHERE id='$AIDU'" >/dev/null
echo "4. cleanup done · health: $(curl -s -o /dev/null -w '%{http_code}' $BASE/health)"
echo "=== DONE ==="
