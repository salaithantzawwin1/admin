#!/usr/bin/env bash
# AMS — admin Telegram bind management + web_url deep-link verification.
set -u
BASE=http://127.0.0.1:3000/api

# SQL via stdin — double-quoted identifiers survive every shell layer untouched
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$1" "$2"; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);console.log(eval('o'+process.argv[1]))}catch(e){console.log('PARSE_FAIL:'+s.slice(0,120))}})" "$1"; }

SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
EMPID=$(q "SELECT id FROM users WHERE username='employee1'")
ETOKEN=$(TOKEN_OF "$EMPID" employee1)
echo "actors: sysadmin=$SAID employee1=$EMPID"

echo "--- 1) users list includes telegram summary:"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/users?pageSize=100" > /tmp/users.json
docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const u=o.items.find(x=>x.username==='employee1');console.log('total:',o.total,'| employee1 telegram:',JSON.stringify(u.telegram))})" < /tmp/users.json
curl -s -H "Authorization: Bearer $ETOKEN" "$BASE/users" -o /dev/null -w "users-as-employee=%{http_code} (expect 403)\n"

echo "--- 2) force unbind with no binding (expect 400):"
curl -s -X DELETE -H "Authorization: Bearer $STOKEN" "$BASE/users/$EMPID/telegram" | head -c 100; echo

echo "--- 3) simulate bind -> list shows linked -> admin unbind -> audit:"
printf 'UPDATE users SET "telegramChatId"='"'"'555000111'"'"', "telegramUsername"='"'"'employee1tg'"'"' WHERE id='"'"'%s'"'"';\n' "$EMPID" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' >/dev/null
echo "db chatId now: $(q "SELECT COALESCE(\"telegramChatId\",'NULL') FROM users WHERE id='$EMPID'")"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/users?pageSize=100" | J ".items.find(x=>x.username==='employee1').telegram"
curl -s -X DELETE -H "Authorization: Bearer $STOKEN" "$BASE/users/$EMPID/telegram"; echo
echo "after unbind: $(q "SELECT COALESCE(\"telegramChatId\",'NULL') FROM users WHERE id='$EMPID'") (expect NULL)"
curl -s -X DELETE -H "Authorization: Bearer $ETOKEN" "$BASE/users/$EMPID/telegram" -o /dev/null -w "unbind-as-employee=%{http_code} (expect 403)\n"
echo "audit: $(q "SELECT action||' by '||COALESCE(username,'-') FROM audit_logs WHERE action='TELEGRAM_ADMIN_UNBIND' ORDER BY \"createdAt\" DESC LIMIT 1")"

echo "--- 4) web_url roundtrip:"
curl -s -X PATCH -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{"webUrl":"http://192.168.100.110"}' "$BASE/settings/telegram"; echo

echo "--- 5) frontend bundle strings:"
docker exec ams-frontend-1 sh -c 'grep -l "Unbind TG" /usr/share/nginx/html/assets/*.js | head -1; grep -l "AMS web URL" /usr/share/nginx/html/assets/*.js | head -1'
echo "backend errors (5m): $(docker logs ams-backend-1 --since 5m 2>&1 | grep -ciE 'TSError|Cannot find|ERR_')"
echo "=== DONE ==="
