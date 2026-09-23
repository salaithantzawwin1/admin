#!/usr/bin/env bash
# Verify the Telegram /assign command is live in the RUNNING backend container.
# Run AFTER a rebuild: docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test up -d --build backend
# Exits non-zero if the running container does not contain the /assign command code.
set -u
cd /opt/admin
C="docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test"

echo "== 1. container status =="
$C ps 2>/dev/null | grep -E "NAME|backend" || docker ps --format '{{.Names}} {{.Status}}' | grep backend

echo "== 2. /assign command code inside the running container =="
if docker exec ams-backend-1 sh -c "grep -c \"handleCommand\" /app/dist/cars/telegram-car-actions.service.js" 2>/dev/null | grep -qE '^[1-9]'; then
  echo "OK: handleCommand present in compiled bundle"
else
  echo "FAIL: /assign code NOT in the running container — rebuild did not pick up new code"
  exit 1
fi

echo "== 3. commands hook wired in telegram.service.js =="
if docker exec ams-backend-1 sh -c "grep -c \"commands\" /app/dist/telegram/telegram.service.js" 2>/dev/null | grep -qE '^[1-9]'; then
  echo "OK: commands hook present"
else
  echo "FAIL: commands hook missing"
  exit 1
fi

echo "== 4. backend health =="
curl -s http://127.0.0.1:3000/api/health

echo ""
echo "== 5. recent backend logs (startup + telegram) =="
$C logs --tail 30 backend 2>/dev/null | grep -iE "telegram|error|nest.*start" | tail -10

echo "== DONE — now send /assign CAR-202609-0036 in Telegram =="
