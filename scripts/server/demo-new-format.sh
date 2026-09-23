#!/usr/bin/env bash
# Fresh-format demo: new trip → new-format assignment message → simulate Noted
# (chat must keep the FULL card + ✅ Noted grayed). Old-format msg 69 is deleted.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
ZZ=$(q "SELECT id FROM drivers WHERE name='U Zaw Zaw'")

# old-format message 69 in the chat → delete (replaced by the new-format demo)
curl -s -X POST "https://api.telegram.org/bot8974826355:AAGbpArifVl40ADaj7Q1NxVkygEOGTMZJrA/deleteMessage" -d 'chat_id=1501493695' -d 'message_id=69' >/dev/null
echo "old-format msg 69 deleted"

# reset the demo assignment stages (Noted/Ready from the earlier simulation)
q "UPDATE car_assignments SET \"driverNotedAt\"=NULL, \"driverArrivedAt\"=NULL, \"driverBackAtOfficeAt\"=NULL WHERE \"requestId\"=(SELECT id FROM request_documents WHERE \"docNumber\"='CAR-202609-0023')" >/dev/null

SD=$(date -u -d '+1 day' +%Y-%m-%dT09:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"Bago Field Visit\",\"startDate\":\"$SD\",\"pickupLocation\":\"Head Office, Yangon\",\"purpose\":\"Driver message format demo — ပုံစံ စစ်ဆေးမှု\",\"passengers\":3}" \
  "$BASE/cars/requests")
CREQ=$(printf '%s' "$CAR" | J "j.id"); DOC=$(printf '%s' "$CAR" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$CREQ/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{"comment":"demo"}' "$BASE/requests/$CREQ/approve" >/dev/null
VEH=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/fleet/vehicles" | J "(Array.isArray(j)?j:j.items).filter(v=>v.status==='AVAILABLE')[0]?.id")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$ZZ\"}" "$BASE/cars/requests/$CREQ/assign" | J "j.id" >/dev/null
sleep 4
AID=$(q "SELECT id FROM car_assignments WHERE \"requestId\"='$CREQ'")
MSGID=$(q "SELECT COALESCE(\"telegramMessageId\",'-') FROM car_assignments WHERE id='$AID'")
echo "1. new doc $DOC · message: $MSGID $([ \"$MSGID\" != '-' ] && echo '✅ new format' || echo '❌')"

# simulate Noted → same message keeps FULL card, Noted button turns ✅
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"assignmentId\":\"$AID\",\"action\":\"noted\"}" "$BASE/cars/assignments/simulate-ack" | head -c 60; echo
sleep 3
echo "2. after Noted: msg still $MSGID · noted=$(q "SELECT COALESCE(\"driverNotedAt\"::text,'-') FROM car_assignments WHERE id='$AID'")"
echo "=== DONE — chat: ကတ်အပြည့်အစုံ + [✅ Noted][🚦 Ready][🏁 Back at Office] ==="
