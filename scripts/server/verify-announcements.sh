#!/usr/bin/env bash
# =============================================================
# AMS — Announcements E2E verify (Plan §18, runs on the server)
# Covers: create → publish → notify → mine → read/ack → stats →
#         attachments upload/list/download → expire guard → RBAC
# =============================================================
set -u
BASE=http://127.0.0.1:3000/api

tok() { docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$1" "$2"; }
uid() { docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM users WHERE username = '$1'\"" | tr -d '\r\n '; }
J() { docker exec -i ams-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }

ATOKEN=$(tok "$(uid admin1)" admin1)
ETOKEN=$(tok "$(uid employee1)" employee1)

echo "== 1) create (IMPORTANT, ALL) =="
A=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"E2E water notice","content":"Water off 9-12 tomorrow.","category":"FACILITY","priority":"IMPORTANT","targets":[{"targetType":"ALL"}]}' \
  "$BASE/announcements")
AID=$(echo "$A" | J "j.id")
echo "$A" | J "'code='+j.code+' status='+j.status+' ack='+j.requiresAck"

echo "== 2) create with future publishAt (SCHEDULED) =="
S=$(curl -s -X POST -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"E2E scheduled","content":"Later.","priority":"NORMAL","publishAt":"2030-01-01T00:00:00.000Z","targets":[{"targetType":"ROLE","targetId":"EMPLOYEE"}]}' \
  "$BASE/announcements")
SID=$(echo "$S" | J "j.id")
echo "$S" | J "'status='+j.status"

echo "== 3) employee cannot create (expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ETOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"xxx","content":"yyyy","targets":[{"targetType":"ALL"}]}' "$BASE/announcements"

echo "== 4) employee /mine before publish (expect 0) =="
curl -s -H "Authorization: Bearer $ETOKEN" "$BASE/announcements/mine" | J "j.filter(x=>x.id==='$AID').length"

echo "== 5) publish =="
curl -s -X POST -H "Authorization: Bearer $ATOKEN" "$BASE/announcements/$AID/publish" | J "'status='+j.status"

echo "== 6) notifications sent (E2E ones) =="
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT COUNT(*) FROM notifications WHERE type='ANNOUNCEMENT' AND title LIKE '%E2E%'\""

echo "== 7) employee /mine now sees it =="
curl -s -H "Authorization: Bearer $ETOKEN" "$BASE/announcements/mine" | J "j.filter(x=>x.id==='$AID').map(x=>'seen='+x.title+' read='+x.read)[0]"

echo "== 8) employee opens detail → read marked =="
curl -s -X POST -H "Authorization: Bearer $ETOKEN" "$BASE/announcements/$AID/read" >/dev/null
curl -s -H "Authorization: Bearer $ETOKEN" "$BASE/announcements/mine" | J "j.filter(x=>x.id==='$AID').map(x=>'read='+x.read)[0]"

echo "== 9) employee acknowledges =="
curl -s -X POST -H "Authorization: Bearer $ETOKEN" "$BASE/announcements/$AID/ack" | head -c 60; echo

echo "== 10) read stats (target/read/unread/acked) =="
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/announcements/$AID/read-stats" | J "'target='+j.target+' read='+j.read+' unread='+j.unread+' acked='+j.acked"

echo "== 11) attachment upload (PNG) =="
docker exec ams-backend-1 node -e "require('fs').writeFileSync('/tmp/a.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPcv5+hHgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==','base64'))"
docker cp ams-backend-1:/tmp/a.png /tmp/a.png
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -F "file=@/tmp/a.png;type=image/png" "$BASE/attachments/upload?announcementId=$AID" | J "'size='+j.size+' mime='+j.mimeType"
FID=$(docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT id FROM attachments WHERE \\\"announcementId\\\"='$AID' LIMIT 1\"" | tr -d '\r\n ')

echo "== 12) attachment list for announcement =="
curl -s -H "Authorization: Bearer $ATOKEN" "$BASE/attachments/announcement/$AID" | J "'files='+j.length"

echo "== 13) attachment download (expect 200 image/png) =="
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -H "Authorization: Bearer $ETOKEN" "$BASE/attachments/$FID/download"

echo "== 14) employee cannot upload to someone else's announcement (expect 403) =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $ETOKEN" -F "file=@/tmp/a.png;type=image/png" "$BASE/attachments/upload?announcementId=$AID"

echo "== 15) delete published blocked (expect 409) =="
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/announcements/$AID"

echo "== 16) published edit allowed + audit-logged =="
curl -s -X PATCH -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"endAt":"2030-06-01T00:00:00.000Z"}' "$BASE/announcements/$AID" | J "'endAt='+j.endAt"
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT action FROM audit_logs WHERE module='ANNOUNCEMENT' ORDER BY \\\"createdAt\\\" DESC LIMIT 3\""

echo "== 17) cleanup =="
curl -s -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/attachments/$FID" | head -c 40; echo
curl -s -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/announcements/$SID" | head -c 40; echo
# published ones are delete-guarded by the API → remove test rows directly (cascades targets/reads/attachment rows)
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -c \"DELETE FROM announcements WHERE title LIKE 'E2E%'\"" >/dev/null
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -c \"DELETE FROM notifications WHERE title LIKE '%E2E%'\"" >/dev/null
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"SELECT 'left='||COUNT(*) FROM announcements WHERE title LIKE 'E2E%'\""
echo "DONE"
