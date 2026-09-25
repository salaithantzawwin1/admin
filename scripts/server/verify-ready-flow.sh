#!/usr/bin/env bash
# E2E: Ready (arrived) stage now notifies BOTH requester (rich message) and
# Administration (oversight), labels use 🚦 Ready, message-edit linkage intact.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }
UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
ZZ=$(q "SELECT id FROM drivers WHERE name='U Zaw Zaw'")
q "UPDATE drivers SET \"telegramChatId\"='1501493695', \"telegramUsername\"='salaithantzawwin' WHERE id='$ZZ'" >/dev/null
SD=$(date -u -d '+2 days' +%Y-%m-%dT03:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"Ready E2E Trip\",\"startDate\":\"$SD\",\"pickupLocation\":\"Head Office\"}" "$BASE/cars/requests")
CREQ=$(printf '%s' "$CAR" | J "j.id")
DOC=$(printf '%s' "$CAR" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$CREQ/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE/requests/$CREQ/approve" >/dev/null
VEH=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/fleet/vehicles" | J "(Array.isArray(j)?j:j.items).filter(v=>v.status==='AVAILABLE')[0]?.id")
AID=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$ZZ\"}" "$BASE/cars/requests/$CREQ/assign" | J "j.id")
echo "assignment: $AID (doc $DOC)"
echo "— driver ack stages via Telegram-equivalent core (simulate-ack):"
for ACT in noted arrived returned; do
  curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"assignmentId\":\"$AID\",\"action\":\"$ACT\"}" "$BASE/cars/assignments/simulate-ack" >/dev/null
done
echo "noted: $(q "SELECT COALESCE(\"driverNotedAt\"::text,'-') FROM car_assignments WHERE id='$AID'")"
echo "ready: $(q "SELECT COALESCE(\"driverArrivedAt\"::text,'-') FROM car_assignments WHERE id='$AID'")"
echo "back:  $(q "SELECT COALESCE(\"driverBackAtOfficeAt\"::text,'-') FROM car_assignments WHERE id='$AID'")"
echo "vehicle after back: $(q "SELECT status FROM vehicles WHERE id='$VEH'") (expect AVAILABLE)"
echo "— notification routing (requester=$UID_ + admins):"
q "SELECT type::text||' → '||u.username FROM notifications n JOIN users u ON u.id=n.\"userId\" WHERE n.\"requestId\"::text='$CREQ' ORDER BY n.\"createdAt\""
echo "— driver message edit linkage preserved (telegramMessageId set on assign):"
echo "msgId: $(q "SELECT COALESCE(\"telegramMessageId\",'-') FROM car_assignments WHERE id='$AID'") (token-less env → '-' expected)"
echo "— bundle strings:"
docker exec ams-frontend-1 sh -c 'grep -l "Ready" /usr/share/nginx/html/assets/*.js | wc -l'
echo "— cleanup:"
q "DELETE FROM car_trips WHERE \"assignmentId\"='$AID'" >/dev/null 2>&1
q "DELETE FROM car_assignments WHERE id='$AID'" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM approval_actions WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM request_documents WHERE id::text='$CREQ'" >/dev/null
q "UPDATE vehicles SET status='AVAILABLE' WHERE status='IN_USE'" >/dev/null
q "UPDATE drivers SET status='AVAILABLE' WHERE status='ON_TRIP'" >/dev/null
q "UPDATE drivers SET \"telegramChatId\"=NULL WHERE id='$ZZ'" >/dev/null
echo done
