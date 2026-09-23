#!/usr/bin/env bash
# Send a REAL driver-view assignment message to @salaithantzawwin's chat (demo trip).
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }

echo "— telegram config: $(q "SELECT (value::text LIKE '%botToken%')::text FROM system_settings WHERE key='telegram'") (token set=1)"
UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
CHAT=1501493695

q "UPDATE employees SET phone='09-770011222' WHERE \"userId\"='$UID_' AND (phone IS NULL OR phone='')" >/dev/null
ZZ=$(q "SELECT id FROM drivers WHERE name='U Zaw Zaw'")
q "UPDATE drivers SET \"telegramChatId\"='$CHAT', \"telegramUsername\"='salaithantzawwin' WHERE id='$ZZ'" >/dev/null
q "UPDATE vehicles SET status='AVAILABLE' WHERE status='IN_USE'" >/dev/null
echo "driver U Zaw Zaw → chat $CHAT (bound for the demo)"

SD=$(date -u -d '+1 day' +%Y-%m-%dT09:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"Bago Field Visit\",\"startDate\":\"$SD\",\"pickupLocation\":\"Head Office, Yangon\",\"purpose\":\"Driver message format demo — လမ်းကြောင်း စစ်ဆေးမှု\",\"passengers\":3}" \
  "$BASE/cars/requests")
CREQ=$(printf '%s' "$CAR" | J "j.id"); DOC=$(printf '%s' "$CAR" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$CREQ/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{"comment":"demo"}' "$BASE/requests/$CREQ/approve" >/dev/null
VEH=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/fleet/vehicles" | J "(Array.isArray(j)?j:j.items).filter(v=>v.status==='AVAILABLE')[0]?.id")
AID=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$ZZ\"}" "$BASE/cars/requests/$CREQ/assign" | J "j.id")
sleep 4
MSGID=$(q "SELECT COALESCE(\"telegramMessageId\",'-') FROM car_assignments WHERE id='$AID'")
echo "doc: $DOC · vehicle: $(q "SELECT \"vehicleNo\" FROM vehicles WHERE id='$VEH'") · assignment: $AID"
echo "telegramMessageId: $MSGID  ($([ "$MSGID" != "-" ] && echo '✅ message delivered to chat' || echo '❌ NOT delivered — check token/enabled'))"
echo "RID=$CREQ"
echo "=== DONE ==="
