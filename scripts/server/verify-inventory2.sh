#!/usr/bin/env bash
set -u
BASE=http://127.0.0.1:3000/api
ATOKEN=$(docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'admin1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''admin1'\''"' | tr -d '\r\n ')")

RID=$(docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM request_documents WHERE \"docNumber\" = '\''OSR-202609-0001'\'';"' | tr -d '\r\n')
BAL0=$(docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc 'SELECT balance FROM inventory_items WHERE id = '\''e14d904f-2ade-44b9-8469-1e42dc1e2065'\'';'" | tr -d '\r\n')
echo "--- fulfill leftover OSR-202609-0001 (balance $BAL0 -> expect $((BAL0-2))):"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/requests/$RID/fulfill" | head -c 120; echo
BAL1=$(docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc 'SELECT balance FROM inventory_items WHERE id = '\''e14d904f-2ade-44b9-8469-1e42dc1e2065'\'';'" | tr -d '\r\n')
echo "balance now = $BAL1"
echo "--- double-fulfill guard (expect 409):"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/requests/$RID/fulfill" | head -c 150; echo
echo "--- frontend bundle contains Inventory page:"
curl -s http://127.0.0.1:8080/assets/$(curl -s http://127.0.0.1:8080/ | grep -o 'index-[^"]*\.js' | head -1) | grep -c "Inventory" || true
echo "--- audit log:"
docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT action, username FROM audit_logs WHERE module = '\''INVENTORY'\'' ORDER BY \"createdAt\" DESC LIMIT 6;"'
