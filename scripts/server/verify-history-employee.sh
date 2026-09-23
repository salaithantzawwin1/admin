#!/usr/bin/env bash
# AMS — E2E: chat bind-history timeline + driver↔employee link with correlated history.
set -u
BASE=http://127.0.0.1:3000/api

q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
CHAT=1501493695

echo "=== 1) migration 20: drivers.employeeId column + unique index ==="
echo "column: $(q "SELECT count(*) FROM information_schema.columns WHERE table_name='drivers' AND column_name='employeeId'") (expect 1)"
echo "index:  $(q "SELECT count(*) FROM pg_indexes WHERE tablename='drivers' AND indexname='drivers_employeeId_key'") (expect 1)"

echo "=== 2) chat bind-history timeline (existing + fresh events) ==="
echo "-- history endpoint for chat $CHAT:"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/settings/telegram/chats/$CHAT/history" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('rows:',r.length);r.slice(0,5).forEach(x=>console.log(' •',x.at,'|',x.label,'|',x.account??'-','| by',x.by))})"
echo "-- employee cannot read history (expect 403):"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TTOKEN" "$BASE/settings/telegram/chats/$CHAT/history"

echo "=== 3) driver ↔ employee link ==="
DRVID=$(q "SELECT id FROM drivers WHERE name='U Zaw Zaw'")
EMPID=$(q "SELECT id FROM employees WHERE \"userId\"='$UID_'")
EMPNAME=$(q "SELECT \"fullName\" FROM employees WHERE id='$EMPID'")
echo "driver=U Zaw Zaw employee=$EMPNAME"
echo "-- link:"
curl -s -X PUT -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d "{\"employeeId\":\"$EMPID\"}" "$BASE/fleet/drivers/$DRVID/employee" | J "j.employee?.fullName ?? JSON.stringify(j).slice(0,100)"; echo
echo "-- listDrivers shows employee:"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/fleet/drivers" | J "(j.items||j).find(d=>d.id===process.argv[1])?.employee?.employeeNo ?? 'MISSING'" "$DRVID"
echo "-- conflict: link same employee to another driver (expect 409):"
DRV2=$(q "SELECT id FROM drivers WHERE \"employeeId\" IS NULL AND id <> '$DRVID' LIMIT 1")
curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d "{\"employeeId\":\"$EMPID\"}" "$BASE/fleet/drivers/$DRV2/employee"
echo "-- fleet-manager (salaithantzawwin has fleet.manage? ADMINISTRATION yes) link via TTOKEN (expect 200/403 per perms):"
curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"employeeId\":\"$EMPID\"}" "$BASE/fleet/drivers/$DRVID/employee"

echo "=== 4) correlated history: assignment via linked employee ==="
SD=$(date -u -d '+2 days' +%Y-%m-%dT03:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"Correlated History Trip\",\"startDate\":\"$SD\"}" "$BASE/cars/requests")
CREQ=$(printf '%s' "$CAR" | J "j.id")
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE/requests/$CREQ/approve" >/dev/null
DRV2=$(q "SELECT id FROM drivers WHERE \"employeeId\" IS NULL AND id <> '$DRVID' AND status='AVAILABLE' ORDER BY \"createdAt\" LIMIT 1")
VEH=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/fleet/vehicles" | J "(j.items||j).filter(v=>v.status==='AVAILABLE')[0]?.id")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$DRV2\"}" "$BASE/cars/requests/$CREQ/assign" | head -c 60; echo
echo "-- correlated history of U Zaw Zaw (assignment was driven by the OTHER driver, requester linked):"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/fleet/drivers/$DRVID/correlated-history" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('employee:',j.employee?.fullName??'-','rows:',j.assignments.length);j.assignments.forEach(a=>console.log(' •',a.docNumber,'| drv',a.driver,'| viaEmployee',a.viaEmployee))})"

echo "=== 5) audit + cleanup this round ==="
q "SELECT action||' x'||count(*) FROM audit_logs WHERE action IN ('DRIVER_EMPLOYEE_LINKED','TELEGRAM_JOIN_APPROVED','TELEGRAM_JOIN_REASSIGNED') GROUP BY action"
q "DELETE FROM car_expenses" >/dev/null; q "DELETE FROM car_trips" >/dev/null; q "DELETE FROM car_assignments" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM approval_actions WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM request_documents WHERE id::text='$CREQ'" >/dev/null
q "UPDATE vehicles SET status='AVAILABLE' WHERE status='IN_USE'" >/dev/null
echo "-- unlink employee (keeps employee record):"
curl -s -o /dev/null -w 'unlink=%{http_code}\n' -X DELETE -H "Authorization: Bearer $STOKEN" "$BASE/fleet/drivers/$DRVID/employee"
echo "car docs remaining: $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='CAR_REQUEST'")"
echo "=== DONE ==="
