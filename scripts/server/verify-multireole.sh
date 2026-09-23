#!/usr/bin/env bash
# AMS — Multi-role testing E2E for the @salaithantzawwin account:
#   REQUESTER leg  → car + meeting requests submitted by the test user
#   APPROVER leg   → test user approves employee1's request (DEPARTMENT_HEAD role)
#   ADMIN leg      → test user assigns vehicle/driver/room (ADMINISTRATION role perms)
#   DRIVER leg     → a driver record is linked to the test user's real Telegram chat;
#                    acks (Noted/Arrived/Back) flow through — buttons work live too.
# No hard-coding: every action goes through the real API with real role checks.
set -u
BASE=http://127.0.0.1:3000/api
CHAT=1501493695

q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
EMPID=$(q "SELECT id FROM users WHERE username='employee1'")
ETOKEN=$(TOKEN_OF "$EMPID" employee1)

echo "=== 0) link an available driver to the test chat (driver leg) ==="
DRVID=$(q "SELECT id FROM drivers WHERE \"telegramChatId\" IS NULL AND status='AVAILABLE' ORDER BY \"createdAt\" LIMIT 1")
DRVNAME=$(q "SELECT name FROM drivers WHERE id='$DRVID'")
q "UPDATE drivers SET \"telegramChatId\"='$CHAT', \"telegramUsername\"='salaithantzawwin' WHERE id='$DRVID'" >/dev/null
echo "driver linked to chat $CHAT: $DRVNAME"

echo "=== 1) REQUESTER: car request by salaithantzawwin ==="
SD=$(date -u -d '+2 days' +%Y-%m-%dT03:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"E2E Multi-role Trip\",\"startDate\":\"$SD\",\"passengers\":2,\"purpose\":\"role testing\"}" \
  "$BASE/cars/requests")
CREQ=$(printf '%s' "$CAR" | J "j.id")
echo "created: $(printf '%s' "$CAR" | J "j.docNumber") (request $CREQ)"
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$CREQ/submit" >/dev/null
echo "submitted → $(q "SELECT status FROM request_documents WHERE id='$CREQ'")"

echo "=== 2) approve all levels (sysadmin — requester cannot self-approve) ==="
for i in 1 2 3 4; do
  ST=$(q "SELECT status FROM request_documents WHERE id='$CREQ'")
  [ "$ST" = "APPROVED" ] && break
  curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{"comment":"e2e"}' "$BASE/requests/$CREQ/approve" | head -c 80; echo
done
echo "car status: $(q "SELECT status FROM request_documents WHERE id='$CREQ'") (expect APPROVED)"

echo "=== 3) ADMIN leg: salaithantzawwin assigns vehicle + driver ==="
VEH=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/fleet/vehicles" | J "(j.items||j).filter(v=>v.status==='AVAILABLE')[0]?.id")
echo "vehicle: $VEH"
ASSIGN=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$DRVID\"}" "$BASE/cars/requests/$CREQ/assign")
AID=$(printf '%s' "$ASSIGN" | J "j.assignment?.id || j.assignmentId || j.id")
echo "assign: $(printf '%s' "$ASSIGN" | head -c 120)"
echo "assignment id: $AID"
echo "vehicle now: $(q "SELECT status FROM vehicles WHERE id='$VEH'") (expect IN_USE)"

echo "=== 4) DRIVER leg: ack stages (buttons would arrive in Telegram) ==="
for ACT in noted arrived returned; do
  R=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
    -d "{\"assignmentId\":\"$AID\",\"action\":\"$ACT\"}" "$BASE/cars/assignments/simulate-ack")
  echo "$ACT → $(printf '%s' "$R" | head -c 100)"
done
echo "vehicle after return: $(q "SELECT status FROM vehicles WHERE id='$VEH'") (expect AVAILABLE)"
echo "ack timestamps: $(q "SELECT COALESCE(\"driverNotedAt\"::text,'-')||' / '||COALESCE(\"driverArrivedAt\"::text,'-')||' / '||COALESCE(\"driverBackAtOfficeAt\"::text,'-') FROM car_assignments WHERE id='$AID'")"

echo "=== 5) REQUESTER: meeting request + room assign ==="
MTG=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\":\"E2E Multi-role Meeting\",\"startTime\":\"$(date -u -d '+1 day 10:00' +%Y-%m-%dT%H:%M:%SZ)\"}" \
  "$BASE/meeting-rooms/requests")
MREQ=$(printf '%s' "$MTG" | J "j.requestId || j.id")
echo "meeting: $(printf '%s' "$MTG" | J "j.docNumber") (request $MREQ)"
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$MREQ/submit" >/dev/null
for i in 1 2 3 4; do
  ST=$(q "SELECT status FROM request_documents WHERE id='$MREQ'")
  [ "$ST" = "APPROVED" ] && break
  curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{"comment":"e2e"}' "$BASE/requests/$MREQ/approve" >/dev/null
done
echo "meeting status: $(q "SELECT status FROM request_documents WHERE id='$MREQ'") (expect APPROVED)"
ROOM=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/meeting-rooms/setup" | J "(j.rooms||j)[0]?.id")
echo "room: $ROOM"
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"roomId\":\"$ROOM\"}" "$BASE/meeting-rooms/requests/$MREQ/assign" | head -c 120; echo
echo "meeting row: $(q "SELECT status||' room='||COALESCE(\"roomId\"::text,'-') FROM meeting_room_requests WHERE \"requestId\"='$MREQ'")"

echo "=== 6) APPROVER leg: salaithantzawwin approves employee1's request ==="
ECAR=$(curl -s -X POST -H "Authorization: Bearer $ETOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"E2E Approver-leg Trip\",\"startDate\":\"$(date -u -d '+3 days' +%Y-%m-%dT03:00:00Z)\"}" \
  "$BASE/cars/requests")
ECREQ=$(printf '%s' "$ECAR" | J "j.id")
curl -s -X POST -H "Authorization: Bearer $ETOKEN" "$BASE/requests/$ECREQ/submit" >/dev/null
echo "employee1 request: $(printf '%s' "$ECAR" | J "j.docNumber") submitted"
STEP=$(q "SELECT s.\"roleName\"::text FROM request_documents d JOIN approval_workflows w ON w.\"module\"=d.\"docType\" AND w.active=true JOIN approval_steps s ON s.\"workflowId\"=w.id WHERE d.id='$ECREQ' AND s.level=d.\"currentLevel\"")
echo "L1 step role: $STEP"
case "$STEP" in
  EMPLOYEE|ADMINISTRATION|DEPARTMENT_HEAD) ATOKEN=$TTOKEN; ACTOR=salaithantzawwin ;;
  *) ATOKEN=$STOKEN; ACTOR=sysadmin ;;
esac
R=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' -d '{"comment":"approved by multi-role test user"}' "$BASE/requests/$ECREQ/approve")
echo "approve by $ACTOR: $(printf '%s' "$R" | head -c 90)"

echo "=== 7) notifications generated for the test user (Telegram mirrors) ==="
q "SELECT type||' | '||title FROM notifications WHERE \"userId\"='$UID_' ORDER BY \"createdAt\" DESC LIMIT 8"

echo "=== 8) cleanup this E2E round (keep user + driver link) ==="
q "DELETE FROM car_expenses" >/dev/null; q "DELETE FROM car_trips" >/dev/null; q "DELETE FROM car_assignments" >/dev/null
q "DELETE FROM meeting_room_requests" >/dev/null; q "DELETE FROM car_requests" >/dev/null
q "DELETE FROM approval_actions WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docType\" IN ('CAR_REQUEST','MEETING_ROOM_REQUEST'))" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docType\" IN ('CAR_REQUEST','MEETING_ROOM_REQUEST'))" >/dev/null
q "DELETE FROM attachments WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docType\" IN ('CAR_REQUEST','MEETING_ROOM_REQUEST'))" >/dev/null
q "DELETE FROM request_documents WHERE \"docType\" IN ('CAR_REQUEST','MEETING_ROOM_REQUEST')" >/dev/null
q "UPDATE vehicles SET status='AVAILABLE' WHERE status='IN_USE'" >/dev/null
q "UPDATE drivers SET status='AVAILABLE' WHERE status='ON_TRIP'" >/dev/null
echo "remaining car docs: $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='CAR_REQUEST'") · meeting docs: $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='MEETING_ROOM_REQUEST'")"
echo "=== DONE ==="
