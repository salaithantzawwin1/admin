#!/bin/bash
# Run on 192.168.100.110 — E2E for the account unlock feature (testing stack :3011).
# 1. lock a demo user by sending 10 bad logins (throttle: 10 fails / 5 min → 15 min lockout)
# 2. users list must show lockedSeconds > 0 for that user
# 3. POST /users/:id/unlock (sysadmin) → cleared
# 4. users list shows lockedSeconds = 0 again
set -e
BASE=http://127.0.0.1:3011/api
ADB="docker exec ams-test-db-1 psql -U ams -d ams -tAc"

SYSID=$($ADB "SELECT id FROM users WHERE username='sysadmin' LIMIT 1" | tr -d '\r\n')
TOK=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:'sysadmin'},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$SYSID")
EUID1=$($ADB "SELECT id FROM users WHERE username='employee1' LIMIT 1" | tr -d '\r\n')

echo "== 1. bad login x10 → lockout =="
for i in $(seq 1 10); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d '{"username":"employee1","password":"wrong-pass"}' "$BASE/auth/login")
  printf '%s ' "$CODE"
done
echo
echo "== 11th attempt (expect 429) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -d '{"username":"employee1","password":"wrong-pass"}' "$BASE/auth/login"

echo "== 2. users list shows lock =="
LOCKED=$(curl -s -H "Authorization: Bearer $TOK" "$BASE/users?pageSize=100" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=JSON.parse(s).items.find(x=>x.username==='employee1');console.log(u.lockedSeconds)})")
echo "employee1 lockedSeconds=$LOCKED (expect > 0)"
[ "$LOCKED" -gt 0 ] || { echo "FAIL — user not shown as locked"; exit 1; }

echo "== 3. unlock =="
curl -s -X POST -H "Authorization: Bearer $TOK" "$BASE/users/$EUID1/unlock"; echo

echo "== 4. users list after unlock =="
LOCKED2=$(curl -s -H "Authorization: Bearer $TOK" "$BASE/users?pageSize=100" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=JSON.parse(s).items.find(x=>x.username==='employee1');console.log(u.lockedSeconds)})")
echo "employee1 lockedSeconds=$LOCKED2 (expect 0 / null)"
[ "$LOCKED2" = "0" ] || [ "$LOCKED2" = "null" ] || { echo "FAIL — still locked"; exit 1; }

echo "== 5. next login attempt is not throttled (expect 401 wrong-password, not 429) =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"username":"employee1","password":"wrong-pass"}' "$BASE/auth/login")
echo "attempt after unlock → $CODE (expect 401)"
[ "$CODE" = "401" ] || { echo "FAIL — throttle still active"; exit 1; }

echo "PASS — lockout shown in users list, unlock clears it, login resumes"
