#!/usr/bin/env bash
# AMS — Inventory module E2E verification (Testing server, direct backend :3000)
# employee1 creates issue request -> admin1 approves (auto-fulfill deducts stock) -> restock -> history
set -u
BASE=http://127.0.0.1:3000/api

ETOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'employee1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''employee1'\''"' | tr -d '\r\n ')")
ATOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'admin1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''admin1'\''"' | tr -d '\r\n ')")

IID=$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM inventory_items WHERE balance > 2 AND \"isActive\" ORDER BY \"createdAt\" LIMIT 1;"' | tr -d '\r\n')
BAL0=$(docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc 'SELECT balance FROM inventory_items WHERE id = '\''$IID'\'';'" | tr -d '\r\n')
echo "item=$IID stock0=$BAL0"

echo "--- 1) items list (employee1 sees catalog):"
curl -s -H "Authorization: Bearer $ETOKEN" "$BASE/inventory/items" | head -c 220; echo

echo "--- 2) employee1 issue request (qty 2):"
RESP=$(curl -s -X POST -H "Authorization: Bearer $ETOKEN" -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"itemId\":\"$IID\",\"quantity\":2}],\"note\":\"E2E verify\"}" "$BASE/inventory/requests")
echo "$RESP" | head -c 200; echo
RID=$(echo "$RESP" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).id)}catch(e){console.log('PARSE_FAIL:'+s.slice(0,80))}})")

echo "--- 3) admin1 approves (workflow -> auto-fulfill -> deduct 2):"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" "$BASE/requests/$RID/approve" | head -c 150; echo
BAL1=$(docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc 'SELECT balance FROM inventory_items WHERE id = '\''$IID'\'';'" | tr -d '\r\n')
DOC=$(docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc 'SELECT status FROM request_documents WHERE id = '\''$RID'\'';'" | tr -d '\r\n')
SUP=$(docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc 'SELECT status FROM office_supply_requests WHERE request_id = '\''$RID'\'';'" | tr -d '\r\n')
echo "stock1=$BAL1 (expect $((BAL0-2))) doc=$DOC supply=$SUP"

echo "--- 4) admin1 restock +10:"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d "{\"itemId\":\"$IID\",\"quantity\":10,\"reference\":\"E2E-PO-1\"}" "$BASE/inventory/restock" | head -c 150; echo
BAL2=$(docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc 'SELECT balance FROM inventory_items WHERE id = '\''$IID'\'';'" | tr -d '\r\n')
echo "stock2=$BAL2 (expect $((BAL0+8)))"

echo "--- 5) stock transaction history:"
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/items/$IID/history" | head -c 350; echo

echo "--- 6) employee1 requests/mine:"
curl -s -H "Authorization: Bearer $ETOKEN" "$BASE/inventory/requests/mine" | head -c 250; echo

echo "--- 7) low-stock endpoint:"
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/low-stock" | head -c 200; echo
