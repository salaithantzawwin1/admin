#!/usr/bin/env bash
# Retry assign for demo doc CAR-202609-0023 with a conflict-free vehicle,
# then verify the driver Telegram assignment message was delivered.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('PARSE_FAIL:'+s.slice(0,300))}})" "$1"; }

RID=ec7afebb-c841-4aa4-a9c2-4271b7f034f5   # request doc CAR-202609-0023
UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
ZZ=$(q "SELECT id FROM drivers WHERE name='U Zaw Zaw'")

# vehicles with NO active car_request booking (status in approval flow)
echo "— active bookings:"; q "SELECT \\\"vehicleId\\\", count(*) FROM car_requests WHERE \\\"vehicleId\\\" IS NOT NULL AND status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS') GROUP BY 1" | sed 's/^/  /'
VEH=$(q "SELECT v.id FROM vehicles v WHERE v.status='AVAILABLE' AND v.id NOT IN (SELECT COALESCE(\"vehicleId\",'00000000-0000-0000-0000-000000000000') FROM car_requests WHERE status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS')) LIMIT 1")
echo "picked vehicle: $(q "SELECT \"vehicleNo\" FROM vehicles WHERE id='$VEH'")"

RESP=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$ZZ\"}" "$BASE/cars/requests/$RID/assign")
echo "assign → $RESP"
AID=$(printf '%s' "$RESP" | J "j.id")
sleep 4
echo "assignment row:"
q "SELECT \"telegramMessageId\", \"driverNotedAt\", \"driverArrivedAt\" FROM car_assignments WHERE id='$AID'" | sed 's/^/  /'
echo "— recent telegram audit:"
q "SELECT action, count(*) FROM audit_logs WHERE action LIKE 'TELEGRAM%' AND \"createdAt\" > now() - interval '5 minutes' GROUP BY 1" | sed 's/^/  /'
echo "=== DONE ==="
