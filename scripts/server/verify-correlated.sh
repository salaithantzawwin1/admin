#!/usr/bin/env bash
# correlated history: assignment driven by ANOTHER driver, requester = linked employee's user
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
ZZ=$(q "SELECT id FROM drivers WHERE name='U Zaw Zaw'")
DRV2=$(q "SELECT id FROM drivers WHERE \"employeeId\" IS NULL AND status='AVAILABLE' AND id <> '$ZZ' ORDER BY \"createdAt\" LIMIT 1")
SD=$(date -u -d '+2 days' +%Y-%m-%dT03:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"destination\":\"Correlated Trip\",\"startDate\":\"$SD\"}" "$BASE/cars/requests")
CREQ=$(printf '%s' "$CAR" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$CREQ/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE/requests/$CREQ/approve" >/dev/null
echo "status: $(q "SELECT status FROM request_documents WHERE id='$CREQ'")"
VEH=$(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/fleet/vehicles" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const l=Array.isArray(j)?j:j.items;console.log(l.filter(v=>v.status==='AVAILABLE')[0].id)})")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d "{\"vehicleId\":\"$VEH\",\"driverId\":\"$DRV2\"}" "$BASE/cars/requests/$CREQ/assign" >/dev/null
echo "assigned to OTHER driver: $DRV2 (U Zaw Zaw = $ZZ, linked employee = requester)"
echo "— correlated history of U Zaw Zaw:"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/fleet/drivers/$ZZ/correlated-history" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('employee:',j.employee?.fullName??'-');j.assignments.forEach(a=>console.log(' •',a.docNumber,'| driver:',a.driver,'| viaEmployee:',a.viaEmployee))})"
echo "— history of the OTHER driver (same row, viaEmployee=false):"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/fleet/drivers/$DRV2/correlated-history" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('employee:',j.employee?.fullName??'-');j.assignments.forEach(a=>console.log(' •',a.docNumber,'| driver:',a.driver,'| viaEmployee:',a.viaEmployee))})"
echo "— cleanup:"
q "DELETE FROM car_expenses" >/dev/null; q "DELETE FROM car_trips" >/dev/null; q "DELETE FROM car_assignments" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM approval_actions WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM request_documents WHERE id::text='$CREQ'" >/dev/null
q "UPDATE vehicles SET status='AVAILABLE' WHERE status='IN_USE'" >/dev/null
echo "car docs: $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='CAR_REQUEST'")"
echo done
