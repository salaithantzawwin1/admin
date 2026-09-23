#!/usr/bin/env bash
# Permanently delete CAR-202609-0022/0023/0024 with every related row (FK order).
set -u
DOCS="'CAR-202609-0022','CAR-202609-0023','CAR-202609-0024'"
q() { printf '%s\n' "$1" | docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }

echo "— deleting related rows:"
q "DELETE FROM car_assignments WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docNumber\" IN ($DOCS)) RETURNING id" | sed 's/^/  car_assignment /'
q "WITH n AS (DELETE FROM notifications WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docNumber\" IN ($DOCS)) RETURNING 1) SELECT '  notifications: ' || count(*) FROM n"
q "WITH a AS (DELETE FROM audit_logs WHERE \"recordId\"::text IN (SELECT id::text FROM request_documents WHERE \"docNumber\" IN ($DOCS)) RETURNING 1) SELECT '  audit_logs: ' || count(*) FROM a"
q "WITH a AS (DELETE FROM approval_actions WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docNumber\" IN ($DOCS)) RETURNING 1) SELECT '  approval_actions: ' || count(*) FROM a"
q "WITH at AS (DELETE FROM attachments WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docNumber\" IN ($DOCS)) RETURNING 1) SELECT '  attachments: ' || count(*) FROM at"
q "DELETE FROM car_requests WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docNumber\" IN ($DOCS)) RETURNING id" | sed 's/^/  car_request /'
q "DELETE FROM request_documents WHERE \"docNumber\" IN ($DOCS) RETURNING \"docNumber\"" | sed 's/^/  request_document /'

echo "— verify:"
q "SELECT '  CAR docs left: ' || count(*) FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%'"
q "SELECT '  car_requests left: ' || count(*) FROM car_requests"
q "SELECT '  car_assignments left: ' || count(*) FROM car_assignments"
q "SELECT '  vehicles: ' || string_agg(\"vehicleNo\" || '=' || status, ', ') FROM vehicles"
echo "=== DONE ==="
