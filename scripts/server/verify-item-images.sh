#!/usr/bin/env bash
set -u
BASE=http://127.0.0.1:3000/api
ATOKEN=$(docker exec ams-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:process.argv[1],username:'admin1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'10m'}))" "$(docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''admin1'\''"' | tr -d '\r\n ')")
IID=$(docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM inventory_items ORDER BY \"createdAt\" LIMIT 1;"' | tr -d '\r\n')
echo "item=$IID"

echo "--- 1) create 1x1 png and upload:"
docker exec ams-backend-1 node -e "
const b=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPcv5+hHgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==','base64');
require('fs').writeFileSync('/tmp/t.png',b);"
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -F "file=@/tmp/t.png;type=image/png" \
  --form-string dummy=x "$BASE/inventory/items/$IID/image" 2>/dev/null | head -c 200; echo

echo "--- retry with proper multipart from container stdin:"
docker cp ams-backend-1:/tmp/t.png /tmp/t.png 2>/dev/null || true
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -F "file=@/tmp/t.png;type=image/png" "$BASE/inventory/items/$IID/image" | head -c 250; echo

echo "--- 2) db column + file on disk:"
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc 'SELECT \"imageStoredName\" FROM inventory_items WHERE id = '\''$IID'\'';'"
docker exec ams-backend-1 sh -c 'ls -la /app/uploads/item-* 2>/dev/null | tail -2'

echo "--- 3) public GET (no auth, expect 200 image/png):"
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/inventory/items/$IID/image"

echo "--- 4) invalid file rejected (txt, expect 400):"
echo hello > /tmp/t.txt
curl -s -X POST -H "Authorization: Bearer $ATOKEN" -F "file=@/tmp/t.txt;type=text/plain" "$BASE/inventory/items/$IID/image" | head -c 120; echo

echo "--- 5) remove image:"
curl -s -X DELETE -H "Authorization: Bearer $ATOKEN" "$BASE/inventory/items/$IID/image"; echo
docker exec ams-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc 'SELECT \"imageStoredName\" FROM inventory_items WHERE id = '\''$IID'\'';'"
echo "--- 6) GET after remove (expect 404):"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/inventory/items/$IID/image"
echo "--- 7) audit:"
docker exec ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT action FROM audit_logs WHERE action LIKE '\''%IMAGE%'\'' ORDER BY \"createdAt\" DESC LIMIT 3;"'
echo "--- 8) frontend bundle has photo UI:"
curl -s http://127.0.0.1/assets/$(curl -s http://127.0.0.1/ | grep -o 'index-[^"]*\.js' | head -1) | grep -c "Item photo" || true
