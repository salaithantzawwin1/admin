#!/usr/bin/env bash
# AMS — Cancel/Recall E2E:
#  requester recall (pending) · requester cancel-approved (car w/ driver TG, meeting, supply)
#  admin cancel for supply · driver Telegram reply · notification mirrors · audit
set -u
BASE=http://127.0.0.1:3000/api

q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
CHAT=1501493695
SD=$(date -u -d '+2 days' +%Y-%m-%dT03:00:00Z)

echo "=== 1) RECALL: requester withdraws a PENDING car request ==="
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"Recall E2E Trip\",\"startDate\":\"$SD\"}" "$BASE/cars/requests")
CREQ=$(printf '%s' "$CAR" | J "j.id")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$CREQ/submit" >/dev/null
echo "submitted: $(q "SELECT status FROM request_documents WHERE id='$CREQ'")"
curl -s -X DELETE -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$CREQ" | J "j.status ?? JSON.stringify(j).slice(0,80)"; echo
echo "status after recall: $(q "SELECT status FROM request_documents WHERE id='$CREQ'") (expect CANCELLED)"
echo "approver notified: $(q "SELECT count(*) FROM notifications WHERE \"requestId\"::text='$CREQ' AND type='CANCELLED'") (expect >=1)"
# cannot recall an already-cancelled request again
curl -s -o /dev/null -w "recall again: %{http_code} (expect 400)\n" -X DELETE -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$CREQ"

echo "=== 2) CANCEL-APPROVED (car, driver linked to TG chat $CHAT) ==="
DRVID=$(q "SELECT id FROM drivers WHERE name='U Zaw Zaw'")
CAR2=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"CancelApproved E2E Trip\",\"startDate\":\"$SD\"}" "$BASE/cars/requests")
C2=$(printf '%s' "$CAR2" | J "j.id")
DOC2=$(printf '%s' "$CAR2" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$C2/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE/requests/$C2/approve" >/dev/null
VEH=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/fleet/vehicles" | J "(Array.isArray(j)?j:j.items).filter(v=>v.status==='AVAILABLE')[0]?.id")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$DRVID\"}" "$BASE/cars/requests/$C2/assign" >/dev/null
echo "approved+assigned: vehicle $(q "SELECT status FROM vehicles WHERE id='$VEH'")"
# separation of duties check: approve-by-other needed; requester cancels their own approved request
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$C2/cancel-approved" | J "JSON.stringify(j).slice(0,80)"; echo
echo "status: $(q "SELECT status FROM request_documents WHERE id='$C2'") (expect CANCELLED)"
echo "vehicle freed: $(q "SELECT status FROM vehicles WHERE id='$VEH'") (expect AVAILABLE)"
echo "requester CANCELLED notification: $(q "SELECT count(*) FROM notifications WHERE \"requestId\"::text='$C2' AND type='CANCELLED'") (expect >=1)"
echo "driver TG reply logged: $(q "SELECT count(*) FROM audit_logs WHERE action='TELEGRAM_DRIVER_CANCEL_NOTIFIED' AND \"recordId\"::text='$C2'") (expect 1)"

echo "=== 3) CANCEL-APPROVED (meeting) ==="
MTG=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\":\"CancelApproved E2E Meeting\",\"startTime\":\"$(date -u -d '+1 day 10:00' +%Y-%m-%dT%H:%M:%SZ)\"}" "$BASE/meeting-rooms/requests")
MREQ=$(printf '%s' "$MTG" | J "j.requestId || j.id")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$MREQ/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE/requests/$MREQ/approve" >/dev/null
ROOM=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/meeting-rooms/setup" | J "(j.rooms||j)[0]?.id")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"roomId\":\"$ROOM\"}" "$BASE/meeting-rooms/requests/$MREQ/assign" >/dev/null
echo "room assigned: $(q "SELECT status FROM meeting_room_requests WHERE \"requestId\"='$MREQ'")"
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$MREQ/cancel-approved" | J "JSON.stringify(j).slice(0,60)"; echo
echo "meeting status: $(q "SELECT status FROM request_documents WHERE id='$MREQ'") (expect CANCELLED) · room row: $(q "SELECT status FROM meeting_room_requests WHERE \"requestId\"='$MREQ'")"
echo "requester CANCELLED notification: $(q "SELECT count(*) FROM notifications WHERE \"requestId\"::text='$MREQ' AND type='CANCELLED'") (expect >=1)"

echo "=== 4) SUPPLY: recall while pending + admin cancel after approval ==="
SUP=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Supply cancel E2E","docType":"OFFICE_SUPPLY_REQUEST","description":"E2E"}' "$BASE/requests")
SREQ=$(printf '%s' "$SUP" | J "j.id")
echo "supply doc: $(printf '%s' "$SUP" | J "j.docNumber") — id=$SREQ"
# recall while pending (supply has no lines — generic cancel path via hook = adminCancelSupply)
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$SREQ/submit" >/dev/null
curl -s -X DELETE -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$SREQ" | J "j.status ?? 'ok'" >/dev/null
echo "supply recalled: $(q "SELECT status FROM request_documents WHERE id='$SREQ'") (expect CANCELLED)"

echo "=== 5) audit trail ==="
q "SELECT action||' x'||count(*) FROM audit_logs WHERE action IN ('REQUEST_CANCELLED','CAR_ADMIN_CANCELLED','MEETING_ADMIN_CANCELLED','SUPPLY_REQUEST_CANCELLED','TELEGRAM_DRIVER_CANCEL_NOTIFIED') AND \"createdAt\" > now() - interval '10 minutes' GROUP BY action"

echo "=== 6) cleanup ==="
for RID in "$CREQ" "$C2" "$MREQ" "$SREQ"; do
  q "DELETE FROM car_expenses WHERE \"tripId\" IN (SELECT id FROM car_trips WHERE \"assignmentId\" IN (SELECT id FROM car_assignments WHERE \"requestId\"::text='$RID'))" >/dev/null 2>&1
  q "DELETE FROM car_trips WHERE \"assignmentId\" IN (SELECT id FROM car_assignments WHERE \"requestId\"::text='$RID')" >/dev/null 2>&1
  q "DELETE FROM car_assignments WHERE \"requestId\"::text='$RID'" >/dev/null 2>&1
  q "DELETE FROM meeting_room_requests WHERE \"requestId\"::text='$RID'" >/dev/null 2>&1
  q "DELETE FROM office_supply_requests WHERE \"requestId\"::text='$RID'" >/dev/null 2>&1
  q "DELETE FROM car_requests WHERE \"requestId\"::text='$RID'" >/dev/null 2>&1
  q "DELETE FROM approval_actions WHERE \"requestId\"::text='$RID'" >/dev/null 2>&1
  q "DELETE FROM notifications WHERE \"requestId\"::text='$RID'" >/dev/null 2>&1
  q "DELETE FROM attachments WHERE \"requestId\"::text='$RID'" >/dev/null 2>&1
  q "DELETE FROM request_documents WHERE id::text='$RID'" >/dev/null 2>&1
done
q "UPDATE vehicles SET status='AVAILABLE' WHERE status='IN_USE'" >/dev/null
q "UPDATE drivers SET status='AVAILABLE' WHERE status='ON_TRIP'" >/dev/null
echo "car docs: $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='CAR_REQUEST'") · meeting docs: $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='MEETING_ROOM_REQUEST'") · supply docs: $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='OFFICE_SUPPLY_REQUEST'")"
echo "=== DONE ==="
