#!/usr/bin/env bash
# AMS — Testing reset:
#  1) delete ALL car + meeting-room requests (docs, sub-records, approvals, notifications,
#     attachments, trips, assignments) and reset vehicles/drivers to AVAILABLE
#  2) create the @salaithantzawwin Telegram-linked test user with 3 real roles
#     (EMPLOYEE + ADMINISTRATION + DEPARTMENT_HEAD) so requester / approver /
#     admin-department flows can be tested from one real account — no hard-coding.
#     NOTE: moves the real Telegram chat binding (1501493695) from any previous
#     holder (admin1) to this user — one chat = one binding.
set -u
BASE=http://127.0.0.1:3000/api
CHAT=1501493695

q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }

echo "=== 1) COUNTS BEFORE ==="
echo "car docs:    $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='CAR_REQUEST'")"
echo "meeting docs:$(q "SELECT count(*) FROM request_documents WHERE \"docType\"='MEETING_ROOM_REQUEST'")"
echo "assignments: $(q "SELECT count(*) FROM car_assignments")"

echo "=== 2) DELETE (FK-safe order) ==="
q "DELETE FROM car_expenses" >/dev/null
q "DELETE FROM car_trips" >/dev/null
q "DELETE FROM car_assignments" >/dev/null
q "DELETE FROM meeting_room_requests" >/dev/null
q "DELETE FROM car_requests" >/dev/null
q "DELETE FROM approval_actions WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docType\" IN ('CAR_REQUEST','MEETING_ROOM_REQUEST'))" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docType\" IN ('CAR_REQUEST','MEETING_ROOM_REQUEST'))" >/dev/null
q "DELETE FROM attachments WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docType\" IN ('CAR_REQUEST','MEETING_ROOM_REQUEST'))" >/dev/null
q "DELETE FROM request_documents WHERE \"docType\" IN ('CAR_REQUEST','MEETING_ROOM_REQUEST')" >/dev/null
q "UPDATE vehicles SET status='AVAILABLE' WHERE status='IN_USE'" >/dev/null
q "UPDATE drivers SET status='AVAILABLE' WHERE status='ON_TRIP'" >/dev/null

echo "=== 3) COUNTS AFTER (all expect 0) ==="
echo "car docs:    $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='CAR_REQUEST'")"
echo "meeting docs:$(q "SELECT count(*) FROM request_documents WHERE \"docType\"='MEETING_ROOM_REQUEST'")"
echo "assignments: $(q "SELECT count(*) FROM car_assignments")"
echo "vehicles IN_USE: $(q "SELECT count(*) FROM vehicles WHERE status='IN_USE'") (expect 0)"
echo "drivers ON_TRIP: $(q "SELECT count(*) FROM drivers WHERE status='ON_TRIP'") (expect 0)"

echo "=== 4) TEST USER (real roles, real Telegram binding) ==="
q "UPDATE telegram_join_requests SET \"boundUserId\"=NULL, \"boundDriverId\"=NULL WHERE \"boundUserId\" IN (SELECT id FROM users WHERE email LIKE '%ams-test.local')" >/dev/null
q "DELETE FROM user_roles WHERE \"userId\" IN (SELECT id FROM users WHERE email LIKE '%ams-test.local')" >/dev/null
q "UPDATE employees SET \"userId\"=NULL WHERE \"userId\" IN (SELECT id FROM users WHERE email LIKE '%ams-test.local')" >/dev/null
q "DELETE FROM users WHERE email LIKE '%ams-test.local'" >/dev/null
# one chat = one binding: free the real chat from any previous holder (e.g. admin1)
PREV=$(q "SELECT username FROM users WHERE \"telegramChatId\"='$CHAT'")
if [ -n "$PREV" ]; then
  echo "moving chat $CHAT away from: $PREV (their binding is freed — they can re-link from Profile later)"
  q "UPDATE users SET \"telegramChatId\"=NULL, \"telegramUsername\"=NULL WHERE \"telegramChatId\"='$CHAT'" >/dev/null
fi
HASH=$(docker exec ams-backend-1 node -e "console.log(require('bcryptjs').hashSync('Testing#2026',10))")
q "INSERT INTO users (id, username, email, \"passwordHash\", \"fullName\", \"telegramChatId\", \"telegramUsername\", \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid(), 'salaithantzawwin', 'salai.tz@ams-test.local', '$HASH', 'Salai Thant Zaw (Testing)', '$CHAT', 'salaithantzawwin', now(), now())" >/dev/null
UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
echo "user id: $UID_"
for ROLE in EMPLOYEE ADMINISTRATION DEPARTMENT_HEAD; do
  q "INSERT INTO user_roles (\"userId\", \"roleId\") SELECT '$UID_', id FROM roles WHERE name='$ROLE' AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.\"roleId\" WHERE ur.\"userId\"='$UID_' AND r.name='$ROLE')" >/dev/null
done
echo "roles: $(q "SELECT string_agg(r.name::text, ', ' ORDER BY r.name::text) FROM user_roles ur JOIN roles r ON r.id=ur.\"roleId\" WHERE ur.\"userId\"='$UID_'")"
ADMIN_DEPT=$(q "SELECT d.id FROM departments d WHERE d.name ILIKE '%admin%' LIMIT 1")
q "INSERT INTO employees (id, \"employeeNo\", \"fullName\", \"departmentId\", \"userId\", \"createdAt\", \"updatedAt\") SELECT gen_random_uuid(), 'EMP-TG-TEST', 'Salai Thant Zaw (Testing)', NULLIF('$ADMIN_DEPT','')::uuid, '$UID_', now(), now() WHERE NOT EXISTS (SELECT 1 FROM employees WHERE \"userId\"='$UID_')" >/dev/null
DEPT=$(q "SELECT COALESCE(e.\"departmentId\"::text,'NONE') FROM employees e WHERE e.\"userId\"='$UID_'")
echo "employee dept: $DEPT"

echo "=== 5) LOGIN + PERMISSION SANITY ==="
LOGIN=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"username":"salaithantzawwin","password":"Testing#2026"}' "$BASE/auth/login")
echo "$LOGIN" | docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('login:',j.user?j.user.username+' roles='+JSON.stringify(j.user.roles):JSON.stringify(j).slice(0,140))})"
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
echo "joins access (users.manage): $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TTOKEN" "$BASE/settings/telegram/joins") (expect 200)"
echo "cars assign perm probe: $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TTOKEN" "$BASE/cars/requests/approved-unassigned") (expect 200)"
echo "=== DONE ==="
