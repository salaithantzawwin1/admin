#!/usr/bin/env bash
set -u
BASE=http://127.0.0.1:3000/api
ATOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'admin1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''admin1'\''"' | tr -d '\r\n ')")
IID=$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM inventory_items ORDER BY \"createdAt\" LIMIT 1;"' | tr -d '\r\n')
LID=$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM inventory_items WHERE balance <= \"minStock\" AND \"isActive\" LIMIT 1;"' | tr -d '\r\n')
echo "item=$IID lowItem=${LID:-none}"

echo "--- 1) restock with unit price 4500.50 x5:"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d "{\"itemId\":\"$IID\",\"quantity\":5,\"unitPrice\":4500.50,\"reference\":\"E2E-PO-2\"}" "$BASE/inventory/restock" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('unitPrice:',j.transaction.unitPrice,'balanceAfter:',j.transaction.balanceAfter,'lastUnitPrice:',j.item.lastUnitPrice)})"

echo "--- 2) spending report (this month):"
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/spending" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('total:',j.total);j.items.forEach(i=>console.log(' ',i.code,i.name,'qty',i.qty,'avg',i.avgUnitPrice,'cost',i.cost,'noPrice:',i.noPrice))})"

echo "--- 3) restock without price (should be accepted, uses no price):"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d "{\"itemId\":\"$IID\",\"quantity\":2,\"reference\":\"E2E-PO-3\"}" "$BASE/inventory/restock" | head -c 80; echo

echo "--- 4) low-stock alert (manual trigger):"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/low-stock/alert"; echo

echo "--- 5) LOW_STOCK notifications in db:"
docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT title, body FROM notifications WHERE type = '\''LOW_STOCK'\'' ORDER BY \"createdAt\" DESC LIMIT 3;"'

echo "--- 6) idempotency — second run sends 0:"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/low-stock/alert"; echo

echo "--- 7) unauthorized spending access (employee1, expect 403):"
ETOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'employee1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''employee1'\''"' | tr -d '\r\n ')")
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ETOKEN" "$BASE/inventory/spending"

echo "--- 8) audit:"
docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT action FROM audit_logs WHERE module = '\''INVENTORY'\'' ORDER BY \"createdAt\" DESC LIMIT 3;"'
