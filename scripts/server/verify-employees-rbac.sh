#!/bin/bash
# Run on 192.168.100.110: verify /org/employees + /org/departments RBAC after fix.
set -e
BASE=http://127.0.0.1:3000/api

mk_tok() {
  local U=$1
  local id=$(docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM users WHERE username='$U'\"" | tr -d '\r\n')
  docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET,{expiresIn:'10m'}))" "$id" "$U"
}

probe() {
  local U=$1; local TOKEN; TOKEN=$(mk_tok "$U")
  local emp_read dept_read
  emp_read=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/auth/me" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(((j.permissions||[]).includes('employees.read'))+' '+((j.permissions||[]).includes('departments.read')))})")
  local e d
  e=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/org/employees?pageSize=5")
  d=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/org/departments")
  printf '%-14s emp.read/dept.read=%-6s /org/employees=%s /org/departments=%s\n' "$U" "$emp_read" "$e" "$d"
}

echo "user           perms            employees  departments"
probe myothiri    # FINANCE+EMPLOYEE — expect 403/403
probe admin1     # ADMINISTRATION+EMPLOYEE — expect 200/200
probe head1      # DEPARTMENT_HEAD+EMPLOYEE — expect 403/200 (dept picker)
probe employee1  # EMPLOYEE — expect 403/403
