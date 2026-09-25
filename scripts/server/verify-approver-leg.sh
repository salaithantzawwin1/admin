#!/usr/bin/env bash
# AMS — Approver leg: salaithantzawwin (DEPARTMENT_HEAD role) approves employee1's request.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
EMPID=$(q "SELECT id FROM users WHERE username='employee1'")
ETOKEN=$(TOKEN_OF "$EMPID" employee1)

echo "=== employee1 creates + submits a car request ==="
ECAR=$(curl -s -X POST -H "Authorization: Bearer $ETOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"E2E Approver-leg Trip\",\"startDate\":\"$(date -u -d '+3 days' +%Y-%m-%dT03:00:00Z)\"}" \
  "$BASE/cars/requests")
ECREQ=$(printf '%s' "$ECAR" | J "j.id")
echo "created: $(printf '%s' "$ECAR" | J "j.docNumber") ($ECREQ)"
curl -s -X POST -H "Authorization: Bearer $ETOKEN" "$BASE/requests/$ECREQ/submit" >/dev/null
echo "status: $(q "SELECT status FROM request_documents WHERE id='$ECREQ'")"

echo "=== workflow steps (module::text cast) ==="
q "SELECT s.level||' → '||s.\"roleName\"::text FROM approval_workflows w JOIN approval_steps s ON s.\"workflowId\"=w.id WHERE w.\"module\"::text='CAR_REQUEST' AND w.active=true ORDER BY s.level"
CUR=$(q "SELECT \"currentLevel\" FROM request_documents WHERE id='$ECREQ'")
STEP=$(q "SELECT s.\"roleName\"::text FROM request_documents d JOIN approval_workflows w ON w.\"module\"::text=d.\"docType\"::text AND w.active=true JOIN approval_steps s ON s.\"workflowId\"=w.id WHERE d.id='$ECREQ' AND s.level=d.\"currentLevel\"")
echo "L$CUR step role: '$STEP'"

if [ "$STEP" = "DEPARTMENT_HEAD" ] || [ "$STEP" = "ADMINISTRATION" ] || [ "$STEP" = "EMPLOYEE" ]; then
  echo "=== salaithantzawwin approves (role $STEP via real user_roles) ==="
  R=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"comment":"approved by multi-role test user"}' "$BASE/requests/$ECREQ/approve")
  echo "→ $(printf '%s' "$R" | J "j.status")"
  echo "status now: $(q "SELECT status FROM request_documents WHERE id='$ECREQ'")"
  echo "approval action: $(q "SELECT a.action::text||' by '||u.username FROM approval_actions a JOIN users u ON u.id=a.\"approverId\" WHERE a.\"requestId\"='$ECREQ' ORDER BY a.level LIMIT 1")"
else
  echo "workflow L1 is '$STEP' — test user has no such role (roles: EMPLOYEE/ADMINISTRATION/DEPARTMENT_HEAD)"
fi

echo "=== cleanup this round ==="
q "DELETE FROM approval_actions WHERE \"requestId\"::text='$ECREQ'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$ECREQ'" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"::text='$ECREQ'" >/dev/null
q "DELETE FROM request_documents WHERE id::text='$ECREQ'" >/dev/null
echo "remaining: $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='CAR_REQUEST'") car docs"
echo "=== DONE ==="
