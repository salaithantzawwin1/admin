#!/bin/bash
# Run on 192.168.100.110: verify Company Time Table + Absence CRUD (prod :80, project ams).
set -e
BASE=http://127.0.0.1:3000/api

AID_USER=$(docker exec ams-db-1 psql -U ams -d ams -tAc "SELECT id FROM users WHERE username='admin1'" | tr -d '\r\n')
TOK=$(docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:'admin1'},process.env.JWT_SECRET,{expiresIn:'10m'}))" "$AID_USER")
DID=$(docker exec ams-db-1 psql -U ams -d ams -tAc 'SELECT id FROM drivers ORDER BY "createdAt" LIMIT 1' | tr -d '\r\n')
DATE=$(date -d '+1 day' +%F)

echo "== timetable default =="
curl -s -H "Authorization: Bearer $TOK" "$BASE/settings/timetable"; echo

echo "== save custom timetable (3 explicit ranges) =="
curl -s -X PUT -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"fullStart":"08:00","fullEnd":"17:30","morningStart":"08:00","morningEnd":"12:30","eveningStart":"12:30","eveningEnd":"17:30","workDays":[1,2,3,4,5]}' \
  "$BASE/settings/timetable"; echo

echo "== create HALF/EVENING absence for $DATE =="
RES=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"driverId\":\"$DID\",\"date\":\"$DATE\",\"dayType\":\"HALF\",\"period\":\"EVENING\",\"reason\":\"smoke test\"}" \
  "$BASE/fleet/absences")
echo "$RES" | head -c 600; echo
AID=$(echo "$RES" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)

echo "== edit to FULL day =="
curl -s -X PATCH -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"date\":\"$DATE\",\"dayType\":\"FULL\",\"period\":\"FULL_DAY\"}" \
  "$BASE/fleet/absences/$AID" | head -c 500; echo

echo "== delete =="
curl -s -X DELETE -H "Authorization: Bearer $TOK" "$BASE/fleet/absences/$AID"; echo

echo "== active absences remaining =="
docker exec ams-db-1 psql -U ams -d ams -tAc "SELECT count(*) FROM driver_absences WHERE status='ACTIVE'"
