#!/bin/bash
# Run on 192.168.100.110: end-to-end API check for myothiri (FINANCE).
set -e
UID_OF=$(docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM users WHERE username='myothiri'\"" | tr -d '\r\n')
TOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'myothiri'}, process.env.JWT_SECRET,{expiresIn:'10m'}))" "$UID_OF")
BASE=http://127.0.0.1:3000/api

echo "== myothiri effective permissions (auth/me) =="
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/auth/me" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('user:',j.username,'| roles:',(j.roles||[]).join(','));console.log('suppliers.read granted?',(j.permissions||[]).includes('suppliers.read'));console.log('inventory.read granted?',(j.permissions||[]).includes('inventory.read'));})"

echo "== GET /suppliers (expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/suppliers"

echo "== GET /suppliers/{id}/history (expect 403) =="
SID=$(docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM suppliers LIMIT 1\"" | tr -d '\r\n')
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/suppliers/$SID/history"

echo "== GET /inventory/items (expect 200 — inventory.read stays) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/inventory/items"

echo "== GET /auth/permissions/matrix (expect 403 — no users.read) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/auth/permissions/matrix"
