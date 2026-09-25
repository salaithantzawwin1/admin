#!/usr/bin/env bash
# AMS — Telegram driver-notification E2E (token-less):
# settings endpoints, assign no-op without token, bind code generation (+employee 403),
# simulated acks (noted/arrived/returned) with notification routing + audit,
# and "Back at Office" freeing the vehicle for an overlapping re-assign.
set -u
BASE=http://127.0.0.1:3000/api

ETOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'employee1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''employee1'\''"' | tr -d '\r\n ')")
ATOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'admin1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''admin1'\''"' | tr -d '\r\n ')")
# settings endpoints are users.manage-gated (same as AD/holidays) — use a SYSTEM_ADMIN account
SAID=$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\" = u.id JOIN roles r ON r.id = ur.\"roleId\" WHERE r.name = '\''SYSTEM_ADMIN'\'' LIMIT 1"' | tr -d '\r\n ')
SA_USER=$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT u.username FROM users u JOIN user_roles ur ON ur.\"userId\" = u.id JOIN roles r ON r.id = ur.\"roleId\" WHERE r.name = '\''SYSTEM_ADMIN'\'' LIMIT 1"' | tr -d '\r\n ')
STOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$SAID" "$SA_USER")
echo "settings actor: $SA_USER ($SAID)"

# SQL via stdin so embedded double-quoted identifiers survive every shell layer
q() { printf '%s' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
json() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);console.log(o['$1']??'MISSING')}catch(e){console.log('PARSE_FAIL')}})"; }

echo "--- 0) telegram settings defaults (system admin) + employee 403 check:"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/settings/telegram"; echo
curl -s -H "Authorization: Bearer $ETOKEN" "$BASE/settings/telegram" -o /dev/null -w "settings-as-employee=%{http_code} (expect 403)\n"

echo "--- 1) patch settings (enabled=false, no token yet):"
curl -s -X PATCH -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{"enabled":false}' "$BASE/settings/telegram"; echo

echo "--- 2) employee1 creates + submits car request:"
RESP=$(curl -s -X POST -H "Authorization: Bearer $ETOKEN" -H 'Content-Type: application/json' \
  -d '{"description":"TG E2E trip","destination":"TG City Hall","startDate":"2026-09-25T09:00:00+06:30","endDate":"2026-09-25T17:00:00+06:30","pickupLocation":"Head Office"}' \
  "$BASE/cars/requests")
RID=$(echo "$RESP" | json id)
echo "request=$RID"
curl -s -X POST -H "Authorization: Bearer $ETOKEN" "$BASE/requests/$RID/submit" -o /dev/null -w "submit=%{http_code}\n"

echo "--- 3) approve + assign vehicle+driver (token-less => telegram must no-op silently):"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" "$BASE/requests/$RID/approve" -o /dev/null -w "approve=%{http_code}\n"
VEH=$(q "SELECT id FROM vehicles WHERE status='AVAILABLE' ORDER BY \"createdAt\" LIMIT 1")
DRV=$(q "SELECT id FROM drivers WHERE status='AVAILABLE' ORDER BY \"createdAt\" LIMIT 1")
echo "vehicle=$VEH driver=$DRV"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$DRV\"}" "$BASE/cars/requests/$RID/assign" | head -c 140; echo
AID=$(q "SELECT id FROM car_assignments WHERE \"requestId\"='$RID'")
echo "assignment=$AID"
echo "msgId='$(q "SELECT \"telegramMessageId\" FROM car_assignments WHERE id='$AID'")' (expect empty — no token)"
echo "doc status after assign: $(q "SELECT status FROM request_documents WHERE id='$RID'") (expect IN_PROGRESS)"

echo "--- 4) bind code generate (admin) + employee access check:"
BC=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" "$BASE/fleet/drivers/$DRV/telegram-bind-code")
echo "$BC" | head -c 120; echo
CODE=$(echo "$BC" | json code)
curl -s -H "Authorization: Bearer $ETOKEN" "$BASE/fleet/drivers/telegram-bindings" -o /dev/null -w "bindings-as-employee=%{http_code} (expect 403)\n"
echo "code stored: $(q "SELECT \"telegramBindCode\" FROM drivers WHERE id='$DRV'")"

echo "--- 5) simulate acks (manual override endpoint):"
for A in noted arrived returned; do
  curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
    -d "{\"assignmentId\":\"$AID\",\"action\":\"$A\"}" "$BASE/cars/assignments/simulate-ack" -o /dev/null -w "$A=%{http_code}\n"
done
q "SELECT 'noted='||COALESCE(\"driverNotedAt\"::text,'-')||' arrived='||COALESCE(\"driverArrivedAt\"::text,'-')||' back='||COALESCE(\"driverBackAtOfficeAt\"::text,'-') FROM car_assignments WHERE id='$AID'"
echo "dup returned guard: $(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' -d "{\"assignmentId\":\"$AID\",\"action\":\"returned\"}" "$BASE/cars/assignments/simulate-ack" -o /dev/null -w '%{http_code}') (expect 200/null-op or body null)"
echo "vehicle status: $(q "SELECT status FROM vehicles WHERE id='$VEH'") (expect AVAILABLE after returned)"
echo "driver status: $(q "SELECT status FROM drivers WHERE id='$DRV'") (expect AVAILABLE)"

echo "--- 6) overlapping re-assign on same vehicle must now succeed:"
RESP2=$(curl -s -X POST -H "Authorization: Bearer $ETOKEN" -H 'Content-Type: application/json' \
  -d '{"description":"TG E2E overlap trip","destination":"TG Market","startDate":"2026-09-25T10:00:00+06:30","endDate":"2026-09-25T12:00:00+06:30"}' \
  "$BASE/cars/requests")
RID2=$(echo "$RESP2" | json id)
curl -s -X POST -H "Authorization: Bearer $ETOKEN" "$BASE/requests/$RID2/submit" -o /dev/null
curl -s -X POST -H "Authorization: Bearer $ATOKEN" "$BASE/requests/$RID2/approve" -o /dev/null -w "approve2=%{http_code}\n"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VEH\"}" "$BASE/cars/requests/$RID2/assign" | head -c 140; echo
echo "doc2=$(q "SELECT status FROM request_documents WHERE id='$RID2'") (expect IN_PROGRESS)"

echo "--- 7) notification routing:"
echo "CAR_DRIVER_NOTED -> admins:      $(q "SELECT count(*) FROM notifications WHERE type='CAR_DRIVER_NOTED' AND \"requestId\"='$RID'")"
echo "CAR_DRIVER_ARRIVED -> requester: $(q "SELECT count(*) FROM notifications WHERE type='CAR_DRIVER_ARRIVED' AND \"requestId\"='$RID'")"
echo "CAR_DRIVER_RETURNED -> admins:   $(q "SELECT count(*) FROM notifications WHERE type='CAR_DRIVER_RETURNED' AND \"requestId\"='$RID'")"

echo "--- 8) audit trail:"
q "SELECT action||' x'||count(*) FROM audit_logs WHERE \"recordId\" IN ('$RID','$RID2') AND action LIKE 'DRIVER%' GROUP BY action"
echo "config audit: $(q "SELECT count(*) FROM audit_logs WHERE action='TELEGRAM_CONFIG_UPDATED'")"

echo "=== DONE (test data: TG E2E trip / TG E2E overlap trip) ==="
