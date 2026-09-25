#!/usr/bin/env bash
# AMS — Telegram join RE-ASSIGN E2E (fix a wrong "assign"): the chat moves between
# accounts atomically; the previous holder is freed; drift surfaces via listJoins.
set -u
BASE=http://127.0.0.1:3000/api

q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$1" "$2"; }
POST() { curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d "$2" "$BASE$1"; }

SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
EMPID=$(q "SELECT id FROM users WHERE username='employee1'")
EMPNAME=$(q "SELECT \"fullName\" FROM users WHERE id='$EMPID'")
OTHER=$(q "SELECT id FROM users WHERE username NOT IN ('employee1','sysadmin') AND \"telegramChatId\" IS NULL ORDER BY \"createdAt\" LIMIT 1")
OTHNAME=$(q "SELECT \"fullName\" FROM users WHERE id='$OTHER'")
DRVID=$(q "SELECT id FROM drivers WHERE \"telegramChatId\" IS NULL ORDER BY \"createdAt\" LIMIT 1")
DRVNAME=$(q "SELECT name FROM drivers WHERE id='$DRVID'")
CHAT=999004
echo "targets: '$EMPNAME' / '$OTHNAME' / driver '$DRVNAME'"

echo "--- 0) reset test state (fresh PENDING join for chat $CHAT @e2emover):"
q "DELETE FROM telegram_join_requests WHERE \"chatId\"='$CHAT'"
q "UPDATE users SET \"telegramChatId\"=NULL, \"telegramUsername\"=NULL WHERE id='$EMPID'"
printf 'INSERT INTO telegram_join_requests (id, "chatId", "tgUsername", "displayName", status, "updatedAt") VALUES (gen_random_uuid(), '\''%s'\'', '\''e2emover'\'', '\''E2E Mover'\'', '\''PENDING'\'', now());\n' "$CHAT" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' >/dev/null
JID=$(q "SELECT id FROM telegram_join_requests WHERE \"chatId\"='$CHAT'")
echo "join=$JID"

echo "--- 1) approve -> $EMPNAME:"
POST "/settings/telegram/joins/$JID/approve" "{\"userId\":\"$EMPID\"}"; echo
echo "  $EMPNAME chat: $(q "SELECT COALESCE(\"telegramChatId\",'NULL') FROM users WHERE id='$EMPID'") (expect $CHAT)"
echo "  join row: $(q "SELECT status||' user='||COALESCE(\"boundUserId\"::text,'-') FROM telegram_join_requests WHERE id='$JID'")"

echo "--- 2) listJoins drift enrichment (APPROVED):"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/settings/telegram/joins?status=APPROVED" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s).find(x=>x.id===process.argv[1]);console.log('  bound =',j&&j.bound?j.bound.kind+':'+j.bound.name:'MISSING')})" "$JID"

echo "--- 3) approve again (expect 409 already approved):"
POST "/settings/telegram/joins/$JID/approve" "{\"userId\":\"$EMPID\"}" | head -c 120; echo

echo "--- 4) REASSIGN -> $OTHNAME:"
POST "/settings/telegram/joins/$JID/reassign" "{\"userId\":\"$OTHER\"}"; echo
echo "  $EMPNAME chat: $(q "SELECT COALESCE(\"telegramChatId\",'NULL') FROM users WHERE id='$EMPID'") (expect NULL)"
echo "  $OTHNAME chat: $(q "SELECT COALESCE(\"telegramChatId\",'NULL') FROM users WHERE id='$OTHER'") (expect $CHAT)"
echo "  join row: $(q "SELECT status||' user='||COALESCE(\"boundUserId\"::text,'-') FROM telegram_join_requests WHERE id='$JID'")"

echo "--- 5) reassign to same target (expect 409 already linked):"
POST "/settings/telegram/joins/$JID/reassign" "{\"userId\":\"$OTHER\"}" | head -c 120; echo

echo "--- 6) REASSIGN -> driver $DRVNAME:"
POST "/settings/telegram/joins/$JID/reassign" "{\"driverId\":\"$DRVID\"}"; echo
echo "  $OTHNAME chat: $(q "SELECT COALESCE(\"telegramChatId\",'NULL') FROM users WHERE id='$OTHER'") (expect NULL)"
echo "  driver chat:   $(q "SELECT COALESCE(\"telegramChatId\",'NULL') FROM drivers WHERE id='$DRVID'") (expect $CHAT)"
echo "  join row: $(q "SELECT status||' driver='||COALESCE(\"boundDriverId\"::text,'-') FROM telegram_join_requests WHERE id='$JID'")"

echo "--- 7) reassign with BOTH targets (expect 409 pick exactly one):"
POST "/settings/telegram/joins/$JID/reassign" "{\"userId\":\"$EMPID\",\"driverId\":\"$DRVID\"}" | head -c 120; echo

echo "--- 8) audit trail:"
q "SELECT action||' x'||count(*) FROM audit_logs WHERE action IN ('TELEGRAM_JOIN_APPROVED','TELEGRAM_JOIN_REASSIGNED') GROUP BY action"

echo "--- 9) cleanup:"
q "UPDATE users SET \"telegramChatId\"=NULL, \"telegramUsername\"=NULL WHERE id IN ('$EMPID','$OTHER')"
q "UPDATE drivers SET \"telegramChatId\"=NULL, \"telegramUsername\"=NULL WHERE id='$DRVID'"
q "DELETE FROM telegram_join_requests WHERE \"chatId\"='$CHAT'"
echo "=== DONE ==="
