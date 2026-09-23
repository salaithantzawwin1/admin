#!/usr/bin/env bash
# debug: approve flow + listDrivers employee include
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
echo "— workflow steps for CAR_REQUEST:"
q "SELECT s.level, s.\"roleName\"::text FROM approval_workflows w JOIN approval_steps s ON s.\"workflowId\"=w.id WHERE w.\"module\"::text='CAR_REQUEST' AND w.active=true ORDER BY s.level"
SD=$(date -u -d '+2 days' +%Y-%m-%dT03:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"Debug Trip\",\"startDate\":\"$SD\"}" "$BASE/cars/requests")
CREQ=$(printf '%s' "$CAR" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$CREQ/submit" >/dev/null
echo "— submit status: $(q "SELECT status FROM request_documents WHERE id='$CREQ'")"
echo "— approve response:"
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE/requests/$CREQ/approve" | head -c 200; echo
echo "— status after: $(q "SELECT status FROM request_documents WHERE id='$CREQ'")"
echo "— listDrivers employee sample:"
curl -s -H "Authorization: Bearer $STOKEN" "$BASE/fleet/drivers" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const list=Array.isArray(j)?j:j.items;const d=list.find(x=>x.name==='U Zaw Zaw');console.log('employee field:',JSON.stringify(d?.employee))})"
echo "— cleanup:"
q "DELETE FROM car_requests WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM approval_actions WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$CREQ'" >/dev/null
q "DELETE FROM request_documents WHERE id::text='$CREQ'" >/dev/null
echo done
