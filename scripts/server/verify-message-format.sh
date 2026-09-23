#!/usr/bin/env bash
# Verify the fixed driver message format: full card stays, grayed buttons accumulate.
# Sends a fresh assignment message, simulates Noted, checks edit, resets the stage.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }

AID=cab5b485-093b-4dda-bece-ca161037e07d   # demo assignment (CAR-202609-0023, chat 1501493695)
UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)

# fresh message in the NEW format (re-send via a release + re-assign cycle)
q "UPDATE car_assignments SET \"releasedAt\"=now() WHERE id='$AID'" >/dev/null
q "UPDATE vehicles SET status='AVAILABLE' WHERE id=(SELECT \"vehicleId\" FROM car_assignments WHERE id='$AID')" >/dev/null
RID=$(q "SELECT \"requestId\" FROM car_assignments WHERE id='$AID'")
VEH=$(q "SELECT \"vehicleId\" FROM car_assignments WHERE id='$AID'")
ZZ=$(q "SELECT \"driverId\" FROM car_assignments WHERE id='$AID'")
RESP=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$ZZ\"}" "$BASE/cars/requests/$RID/assign")
MSGID=$(printf '%s' "$RESP" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).telegramMessageId||'PENDING')}catch(e){console.log('FAIL')}})")
sleep 4
MSGID=$(q "SELECT COALESCE(\"telegramMessageId\",'-') FROM car_assignments WHERE id='$AID'")
echo "1. fresh message (new format): $MSGID $([ \"$MSGID\" != '-' ] && echo '✅' || echo '❌')"

# simulate Noted → message must keep the FULL card + turn Noted ✅
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"assignmentId\":\"$AID\",\"action\":\"noted\"}" "$BASE/cars/assignments/simulate-ack" >/dev/null
sleep 3
echo "2. after Noted:"
q "SELECT '  noted=' || COALESCE(\"driverNotedAt\"::text,'-') || ' · msg=' || COALESCE(\"telegramMessageId\",'-') FROM car_assignments WHERE id='$AID'"

# simulate Ready → Noted AND Ready ✅
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"assignmentId\":\"$AID\",\"action\":\"arrived\"}" "$BASE/cars/assignments/simulate-ack" >/dev/null
sleep 3
echo "3. after Ready:"
q "SELECT '  noted=' || COALESCE(\"driverNotedAt\"::text,'-') || ' · arrived=' || COALESCE(\"driverArrivedAt\"::text,'-') FROM car_assignments WHERE id='$AID'"

echo "— recent telegram warnings (should be 0):"
docker logs ams-backend-1 --since 2m 2>&1 | grep -c "Telegram.*failed\|Telegram.*error" || true
echo "=== DONE — check the chat: card intact, ✅ Noted, ✅ Ready, 🏁 Back at Office active ==="
