#!/usr/bin/env bash
# Reassign E2E: assign V1+D1 → reassign to V2+D2 →
#   old driver TG cancel notice, new driver route message, requester notified,
#   V1/D1 AVAILABLE, V2/D2 IN_USE/ON_TRIP, audit CAR_REASSIGNED. Cleanup after.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
AIDU=$(q "SELECT id FROM users WHERE username='admin1'")
ATOKEN=$(TOKEN_OF "$AIDU" admin1)

# bind the demo driver chat again (real Telegram check)
ZZ1=$(q "SELECT id FROM drivers WHERE name='U Zaw Zaw'")
q "UPDATE drivers SET \"telegramChatId\"='1501493695', \"telegramUsername\"='salaithantzawwin' WHERE id='$ZZ1'" >/dev/null

SD=$(date -u -d '+5 days' +%Y-%m-%dT09:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"Reassign Test\",\"startDate\":\"$SD\",\"purpose\":\"reassign E2E\",\"passengers\":2}" "$BASE/cars/requests")
RID=$(printf '%s' "$CAR" | J "j.id"); DOC=$(printf '%s' "$CAR" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$RID/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' -d '{"comment":"e2e"}' "$BASE/requests/$RID/approve" >/dev/null

V1=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/fleet/vehicles" | J "(Array.isArray(j)?j:j.items).find(v=>v.vehicleNo==='YGN-1234')?.id")
V2=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/fleet/vehicles" | J "(Array.isArray(j)?j:j.items).find(v=>v.vehicleNo==='YGN-5678')?.id")
D2=$(q "SELECT id FROM drivers WHERE name<>'U Zaw Zaw' AND status='AVAILABLE' LIMIT 1")
D2NAME=$(q "SELECT name FROM drivers WHERE id='$D2'")

curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$V1\",\"driverId\":\"$ZZ1\"}" "$BASE/cars/requests/$RID/assign" | J "j.id" >/dev/null
sleep 3
M1=$(q "SELECT COALESCE(\"telegramMessageId\",'-') FROM car_assignments WHERE \"requestId\"='$RID'")
echo "1. assigned V1=YGN-1234 + D1=U Zaw Zaw → TG msg $M1"

# reassign to V2 + D2
RESP=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$V2\",\"driverId\":\"$D2\"}" "$BASE/cars/requests/$RID/reassign")
echo "2. reassign → $(printf '%s' "$RESP" | head -c 120)"
sleep 4

echo "3. old driver U Zaw Zaw chat: $(q "SELECT COALESCE(\"telegramChatId\",'—') FROM drivers WHERE id='$ZZ1'") · status: $(q "SELECT status FROM drivers WHERE id='$ZZ1'")"
echo "4. new driver $D2NAME status: $(q "SELECT status FROM drivers WHERE id='$D2'") · vehicle states: $(q "SELECT string_agg(\"vehicleNo\"||'='||status,', ') FROM vehicles WHERE id IN ('$V1','$V2')")"
echo "5. TG messages: old-driver notice=$(q "SELECT count(*) FROM audit_logs WHERE action='TELEGRAM_DRIVER_REASSIGN_NOTIFIED' AND \"recordId\"::text='$RID'") · new-driver msg=$(q "SELECT COALESCE(\"telegramMessageId\",'-') FROM car_assignments WHERE \"requestId\"='$RID'")"
echo "6. requester notification: $(q "SELECT count(*) FROM notifications WHERE \"requestId\"::text='$RID' AND title LIKE 'Vehicle changed%'")"
echo "7. audit CAR_REASSIGNED: $(q "SELECT count(*) FROM audit_logs WHERE action='CAR_REASSIGNED' AND \"recordId\"::text='$RID'")"
echo "8. guards: same-pick → $(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"vehicleId\":\"$V2\",\"driverId\":\"$D2\"}" "$BASE/cars/requests/$RID/reassign" | head -c 80)"
echo "=== cleanup ==="
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"reason":"reassign e2e cleanup"}' "$BASE/requests/$RID/cancel-approved" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$RID'" >/dev/null
q "DELETE FROM audit_logs WHERE \"recordId\"::text='$RID'" >/dev/null
q "DELETE FROM car_assignments WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM approval_actions WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM request_documents WHERE id='$RID'" >/dev/null
q "UPDATE drivers SET \"telegramChatId\"=NULL, \"telegramUsername\"=NULL WHERE id='$ZZ1'" >/dev/null
q "UPDATE drivers SET status='AVAILABLE' WHERE id IN ('$ZZ1','$D2')" >/dev/null
q "UPDATE vehicles SET status='AVAILABLE' WHERE id IN ('$V1','$V2')" >/dev/null
echo "cleanup done · health: $(curl -s -o /dev/null -w '%{http_code}' $BASE/health)"
echo "=== DONE ==="
