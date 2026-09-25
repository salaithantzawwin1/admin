#!/bin/bash
# Run on 192.168.100.110: verify the TESTING stack (:8030, project ams-test).
set -e
BASE=http://127.0.0.1:3011/api
DB=ams-test-db-1
BE=ams-test-backend-1

mk_tok() {
  local U=$1
  local id=$(docker exec $DB psql -U ams -d ams -tAc "SELECT id FROM users WHERE username='$U'" | tr -d '\r\n')
  docker exec $BE node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET,{expiresIn:'10m'}))" "$id" "$U"
}

row() {
  local U=$1; local T; T=$(mk_tok "$U")
  local s e i
  s=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/suppliers")
  e=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/org/employees?pageSize=5")
  i=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "$BASE/inventory/items")
  printf 'TESTING %-12s suppliers=%s employees=%s inventory=%s\n' "$U" "$s" "$e" "$i"
}

row admin1      # ADMINISTRATION+EMPLOYEE → all 200
row employee1   # EMPLOYEE → suppliers 403, employees 403, inventory 200
echo "health: $(curl -s $BASE/health | head -c 120)"
