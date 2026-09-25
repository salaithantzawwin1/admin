#!/bin/bash
# Run on 192.168.100.110: prove deny-memory survives a backend restart.
set -e
BASE=http://127.0.0.1:3000/api

mk_tok() {
  local U=$1
  local id=$(docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM users WHERE username='$U'\"" | tr -d '\r\n')
  docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET,{expiresIn:'10m'}))" "$id" "$U"
}

check() {
  local U=$1; local TOKEN; TOKEN=$(mk_tok "$U")
  local granted=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/auth/me" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log((j.permissions||[]).includes('suppliers.read'))})")
  local code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/suppliers")
  echo "$U: suppliers.read=$granted  GET /suppliers=$code"
}

echo "=== BEFORE restart ==="
check myothiri
check admin1

echo "=== restarting backend ==="
docker restart ams-test-backend-1 >/dev/null
sleep 14
docker logs ams-test-backend-1 --since 1m 2>&1 | grep -E 'RBAC|migrations|listening' | head -4

echo "=== AFTER restart (deny must survive) ==="
check myothiri
check admin1
