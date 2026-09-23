#!/usr/bin/env bash
set -u
BASE=http://127.0.0.1:3000/api
ATOKEN=$(docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'admin1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''admin1'\''"' | tr -d '\r\n ')")

echo "--- 1) backfilled suppliers (from legacy free-text):"
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/suppliers" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s).forEach(x=>console.log(x.name,'| active:',x.isActive))})"

echo "--- 2) create supplier with contact info:"
SID=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Test Vendor Co.","phone":"09-1234567","address":"Yangon"}' "$BASE/inventory/suppliers" \
  | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
echo "created id=$SID"

echo "--- 3) duplicate name rejected (409):"
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Test Vendor Co."}' "$BASE/inventory/suppliers"

echo "--- 4) restock with supplierId:"
IID=$(docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM inventory_items WHERE code = '\''ITM-0003'\'';"' | tr -d '\r\n ')
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d "{\"itemId\":\"$IID\",\"quantity\":10,\"unitPrice\":500,\"supplierId\":\"$SID\",\"reference\":\"PO-2026-015\"}" "$BASE/inventory/restock" \
  | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('supplier:',j.transaction.supplier,'| supplierId:',j.transaction.supplierId)})"

echo "--- 5) spending groups under master supplier:"
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/spending" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s).suppliers.forEach(x=>console.log(x.supplier,'| qty',x.qty,'| cost',x.cost))})"

echo "--- 6) delete with history rejected (409):"
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/suppliers/$SID"

echo "--- 7) deactivate instead:"
curl -s -X PATCH -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' -d '{"isActive":false}' "$BASE/inventory/suppliers/$SID" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('isActive:',j.isActive)})"
echo "--- 8) hidden from default list, visible with all=1:"
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/suppliers" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('default count:',JSON.parse(s).length))"
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/suppliers?all=1" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('all count:',JSON.parse(s).length))"

echo "--- 9) audit:"
docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT action FROM audit_logs WHERE action LIKE '\''%SUPPLIER%'\'' ORDER BY \"createdAt\" DESC LIMIT 4;"'
