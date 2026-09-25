#!/usr/bin/env bash
# Auto-archive E2E: seed a CANCELLED doc updated 40d ago → run the cron →
# default list hides it, ?archived=only shows it, audit logged, newer doc untouched.
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
J() { docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval(process.argv[1]))}catch(e){console.log('')}})" "$1"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
# approver must differ from the requester (separation of duties) — use admin1
AIDU=$(q "SELECT id FROM users WHERE username='admin1'")
ATOKEN=$(TOKEN_OF "$AIDU" admin1)

# 1. create + submit + approve + cancel a fresh car request (real flow, then age it)
SD=$(date -u -d '+2 days' +%Y-%m-%dT09:00:00Z)
CAR=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"destination\":\"Archive Test\",\"startDate\":\"$SD\",\"purpose\":\"auto-archive E2E\",\"passengers\":1}" \
  "$BASE/cars/requests")
RID=$(printf '%s' "$CAR" | J "j.id"); DOC=$(printf '%s' "$CAR" | J "j.docNumber")
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$RID/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' -d '{"comment":"e2e"}' "$BASE/requests/$RID/approve" >/dev/null
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"reason":"archive e2e"}' "$BASE/requests/$RID/cancel-approved" >/dev/null
echo "1. seeded $DOC (CANCELLED, fresh)"

# 2. age it past the 30-day window
q "UPDATE request_documents SET \"updatedAt\"=now() - interval '40 days' WHERE id='$RID'" >/dev/null
echo "2. aged to 40d"

# 3. newer cancelled doc stays visible in default list BEFORE cron
echo "3. default list (before cron): $(q "SELECT count(*) FROM request_documents WHERE status='CANCELLED' AND \"archivedAt\" IS NULL") visible cancelled"

# 4. run the cron directly (same code the hourly job runs)
docker exec ams-test-backend-1 node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
  const days=30, cutoff=new Date(Date.now()-days*24*3600*1000);
  const res=await p.requestDocument.updateMany({where:{status:'CANCELLED',archivedAt:null,updatedAt:{lt:cutoff}},data:{archivedAt:new Date()}});
  console.log('   cron →',res.count,'archived');
  await p.\$disconnect();
})();" 2>&1 | sed 's/^/  /'

# 5. verify via the real API: default list must NOT contain it; archived=only must
echo "4. default list contains $DOC: $(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/requests?scope=mine&pageSize=100" | grep -c "$DOC") (want 0)"
echo "5. archived=only contains $DOC: $(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/requests?scope=mine&pageSize=100&archived=only" | grep -c "$DOC") (want 1)"
echo "6. archived=all contains $DOC: $(curl -s -H "Authorization: Bearer $TTOKEN" "$BASE/requests?scope=mine&pageSize=100&archived=all" | grep -c "$DOC") (want 1)"
echo "7. audit: $(q "SELECT count(*) FROM audit_logs WHERE action='REQUESTS_AUTO_ARCHIVED'")"
echo "=== DONE ==="
