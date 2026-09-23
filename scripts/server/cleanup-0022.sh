#!/usr/bin/env bash
# Clean up the stale morning E2E doc CAR-202609-0022 (frees vehicle 1G/5575).
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }

UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
RID=$(q "SELECT id FROM request_documents WHERE \"docNumber\"='CAR-202609-0022'")
echo "cancel CAR-202609-0022 ($RID):"
curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' -d '{"reason":"E2E leftover cleanup"}' "$BASE/requests/$RID/cancel-approved" | head -c 200; echo
echo "— final state:"
q "SELECT v.\"vehicleNo\", v.status FROM vehicles v ORDER BY 1" | sed 's/^/  vehicle /'
q "SELECT count(*) FROM car_assignments WHERE \"releasedAt\" IS NULL" | sed 's/^/  active assignments: /'
echo "=== DONE ==="
