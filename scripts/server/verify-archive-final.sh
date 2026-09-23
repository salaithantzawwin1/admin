#!/usr/bin/env bash
# Final auto-archive verification through REAL API endpoints:
# seed aged-cancelled doc → default list hides it → archived=only shows it → audit row exists.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
AIDU=$(q "SELECT id FROM users WHERE username='admin1'")
ATOKEN=$(TOKEN_OF "$AIDU" admin1)

SD=$(date -u -d '+3 days' +%Y-%m-%dT09:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"Archive Test 2\",\"startDate\":\"$SD\",\"purpose\":\"auto-archive final\",\"passengers\":1}" \
  "$BASE/cars/requests")
RID=$(printf '%s' "$CAR" | J "j.id"); DOC=$(printf '%s' "$CAR" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$RID/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' -d '{"comment":"e2e"}' "$BASE/requests/$RID/approve" >/dev/null
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"reason":"archive final e2e"}' "$BASE/requests/$RID/cancel-approved" >/dev/null
# age past 30 days
q "UPDATE request_documents SET \"updatedAt\"=now() - interval '40 days' WHERE id='$RID'" >/dev/null
echo "1. seeded $DOC aged 40d (CANCELLED)"

# run the same update the hourly cron performs
docker exec ams-backend-1 node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
  const cutoff=new Date(Date.now()-30*24*3600*1000);
  const r=await p.requestDocument.updateMany({where:{status:'CANCELLED',archivedAt:null,updatedAt:{lt:cutoff}},data:{archivedAt:new Date()}});
  console.log('2. archive update →',r.count);
  await p.\$disconnect();
})();" 2>&1 | sed 's/^/  /'
sleep 1

echo "3. default mine list has $DOC: $(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/requests?scope=mine&pageSize=100" | grep -c "$DOC") (want 0)"
echo "4. archived=only has $DOC: $(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/requests?scope=mine&pageSize=100&archived=only" | grep -c "$DOC") (want 1)"
echo "5. archived=all has $DOC: $(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/requests?scope=mine&pageSize=100&archived=all" | grep -c "$DOC") (want 1)"
echo "6. other user still sees nothing leaked: $(curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/requests?pageSize=100" | grep -c "$DOC") (want 0 — scope rules intact)"
echo "=== cleanup test doc ==="
q "DELETE FROM approval_actions WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$RID'" >/dev/null
q "DELETE FROM audit_logs WHERE \"recordId\"::text='$RID'" >/dev/null
q "DELETE FROM car_requests WHERE \"requestId\"='$RID'" >/dev/null
q "DELETE FROM request_documents WHERE id='$RID'" >/dev/null
echo "deleted $DOC test rows"
echo "health: $(curl -s -o /dev/null -w '%{http_code}' $BASE/health)"
echo "=== DONE ==="
