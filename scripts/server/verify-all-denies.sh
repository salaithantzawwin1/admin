#!/bin/bash
# Run on 192.168.100.110: combined regression — suppliers + employees denies, then restart resilience.
set -e
BASE=http://127.0.0.1:3000/api

mk_tok() {
  local U=$1
  local id=$(docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM users WHERE username='$U'\"" | tr -d '\r\n')
  docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET,{expiresIn:'10m'}))" "$id" "$U"
}

row() {
  local U=$1; local T; T=$(mk_tok "$U")
  local s e i
  s=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/suppliers")
  e=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/org/employees?pageSize=5")
  i=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/inventory/items")
  printf '%-14s suppliers=%s employees=%s inventory=%s\n' "$U" "$s" "$e" "$i"
}

echo "== BEFORE restart =="
row myothiri
row admin1

docker restart ams-backend-1 >/dev/null
sleep 14

echo "== AFTER restart =="
row myothiri
row admin1
