#!/usr/bin/env bash
set -u
BASE=http://127.0.0.1:3000/api
ATOKEN=$(docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'admin1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''admin1'\''"' | tr -d '\r\n ')")

echo "--- 1) purchase-totals (lifetime):"
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/purchase-totals" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s).forEach(i=>console.log(i.code,i.name,'| qty',i.qty,'| cost',i.cost,'| avg',i.avgUnitPrice,'| est:',i.estimated))})"

echo "--- 2) CSV export (this month):"
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/spending.csv" | head -5

echo "--- 3) CSV for last month (expect header + TOTAL 0 rows):"
ST=$(date -u -d 'last month' +%Y-%m-01 2>/dev/null || date -u +%Y-%m-01)
EN=$(date -u +%Y-%m-01)
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/spending.csv?start=${ST}00%3A00%3A00.000Z&end=${EN}00%3A00%3A00.000Z" | head -3

echo "--- 4) employee1 denied (403):"
ETOKEN=$(docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'employee1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''employee1'\''"' | tr -d '\r\n ')")
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ETOKEN" "$BASE/inventory/spending.csv"

echo "--- 5) frontend bundle has Purchases tab + CSV:"
curl -s http://127.0.0.1/assets/$(curl -s http://127.0.0.1/ | grep -o 'index-[^"]*\.js' | head -1) | grep -o "Purchases\|Lifetime purchased" | sort | uniq -c
