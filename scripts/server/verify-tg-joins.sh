#!/usr/bin/env bash
# AMS — Telegram join (draft → approve → bind) E2E.
set -u
BASE=http://127.0.0.1:3000/api

q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$1" "$2"; }

SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
EMPID=$(q "SELECT id FROM users WHERE username='employee1'")

echo "--- 1) simulate a /start join (as Telegram user 777001, @e2etguser):"
printf 'INSERT INTO telegram_join_requests (id, "chatId", "tgUsername", "displayName", status, "updatedAt") VALUES (gen_random_uuid(), '\''777001'\'', '\''e2etguser'\'', '\''E2E TG User'\'', '\''PENDING'\'', now()) ON CONFLICT ("chatId") DO UPDATE SET status='\''PENDING'\'', "tgUsername"='\''e2etguser'\'', "updatedAt"=now();\n' | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' >/dev/null
JOINS=$(curl -s -H "Authorization: Bearer $STOKEN" "$BASE/settings/telegram/joins")
printf '%s' "$JOINS" > /tmp/joins.json
docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s).find(x=>x.chatId==='777001');console.log('join draft:',j?j.displayName+' @'+j.tgUsername:'MISSING')})" < /tmp/joins.json
JID=$(printf '%s' "$JOINS" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s).find(x=>x.chatId==='777001');console.log(j?j.id:'')})")
# employee cannot manage joins
ETOKEN=$(TOKEN_OF "$EMPID" employee1)
curl -s -H "Authorization: Bearer $ETOKEN" "$BASE/settings/telegram/joins" -o /dev/null -w "joins-as-employee=%{http_code} (expect 403)\n"

echo "--- 2) approve with both targets (expect 409):"
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d "{\"userId\":\"$EMPID\",\"driverId\":\"x\"}" "$BASE/settings/telegram/joins/$JID/approve" | head -c 110; echo

echo "--- 3) approve with system user (employee1):"
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d "{\"userId\":\"$EMPID\"}" "$BASE/settings/telegram/joins/$JID/approve"; echo
echo "user bind: $(q "SELECT COALESCE(\"telegramChatId\",'NULL')||' @'||COALESCE(\"telegramUsername\",'-') FROM users WHERE id='$EMPID'") (expect 777001 @e2etguser)"
echo "join row:  $(q "SELECT status||' user='||COALESCE(\"boundUserId\"::text,'-') FROM telegram_join_requests WHERE id='$JID'")"

echo "--- 4) double approve (expect 409):"
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d "{\"userId\":\"$EMPID\"}" "$BASE/settings/telegram/joins/$JID/approve" | head -c 110; echo

echo "--- 5) new join for same chat after re-/start -> upserts back to PENDING; chat conflict on other user:"
printf 'UPDATE telegram_join_requests SET status='\''PENDING'\'' WHERE "chatId"='\''777001'\'';\n' | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' >/dev/null
# employee1 already holds the chat → approving for a different user must 409
OTHER=$(q "SELECT id FROM users WHERE username <> 'employee1' AND username <> 'sysadmin' LIMIT 1")
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d "{\"userId\":\"$OTHER\"}" "$BASE/settings/telegram/joins/$JID/approve" | head -c 130; echo

echo "--- 6) reject path:"
printf 'INSERT INTO telegram_join_requests (id, "chatId", "tgUsername", "displayName", status, "updatedAt") VALUES (gen_random_uuid(), '\''888002'\'', '\''spamuser'\'', '\''Spam Bot'\'', '\''PENDING'\'', now()) ON CONFLICT ("chatId") DO UPDATE SET status='\''PENDING'\'', "updatedAt"=now();\n' | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' >/dev/null
JID2=$(q "SELECT id FROM telegram_join_requests WHERE \"chatId\"='888002'")
curl -s -X POST -H "Authorization: Bearer $STOKEN" "$BASE/settings/telegram/joins/$JID2/reject"; echo
echo "join2 status: $(q "SELECT status FROM telegram_join_requests WHERE id='$JID2'") (expect REJECTED)"

echo "--- 7) audit trail:"
q "SELECT action||' x'||count(*) FROM audit_logs WHERE action IN ('TELEGRAM_JOIN_REQUESTED','TELEGRAM_JOIN_APPROVED','TELEGRAM_JOIN_REJECTED') GROUP BY action"
echo "--- cleanup test bindings:"
printf 'UPDATE users SET "telegramChatId"=NULL, "telegramUsername"=NULL WHERE id='"'"'%s'"'"'; DELETE FROM telegram_join_requests WHERE "chatId" IN ('"'"'777001'"'"','"'"'888002'"'"');\n' "$EMPID" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' >/dev/null
echo "=== DONE ==="
