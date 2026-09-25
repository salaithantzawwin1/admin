#!/bin/bash
# Run on 192.168.100.110: end-to-end API check for myothiri (FINANCE) on PRODUCTION (:80, project ams).
set -e
UID_OF=$(docker exec ams-db-1 psql -U ams -d ams -tAc "SELECT id FROM users WHERE username='myothiri'" | tr -d '\r\n')
TOKEN=$(docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'myothiri'}, process.env.JWT_SECRET,{expiresIn:'10m'}))" "$UID_OF")
BASE=http://127.0.0.1:3000/api

echo "== myothiri effective permissions (auth/me) =="
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/auth/me" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('user:',j.username,'| roles:',(j.roles||[]).join(','));console.log('suppliers.read granted?',(j.permissions||[]).includes('suppliers.read'));console.log('employees.read granted?',(j.permissions||[]).includes('employees.read'));console.log('inventory.read granted?',(j.permissions||[]).includes('inventory.read'));})"

echo "== GET /suppliers (expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/suppliers"

echo "== GET /org/employees (expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/org/employees?pageSize=5"

echo "== GET /inventory/items (expect 200) =="
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/inventory/items"
