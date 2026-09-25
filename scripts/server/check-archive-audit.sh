#!/usr/bin/env bash
q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
echo "archive audit rows:"
q "SELECT action || ' · ' || left(coalesce(\"newValue\"::text,''),70) || ' · ' || \"createdAt\" FROM audit_logs WHERE action LIKE '%ARCHIVE%' ORDER BY \"createdAt\" DESC LIMIT 3"
echo "health: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health)"
