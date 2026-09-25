#!/usr/bin/env bash
# Purge ALL car-request testing data (every CAR-* document) with every related row,
# for ALL users — including notifications, audit rows, assignments, trips, expenses.
# FK-order safe; restores vehicles/drivers to AVAILABLE and resets the CAR numbering
# counter so the next car request starts again at CAR-<year>-0001.
#
# Run on the server:  bash /opt/admin/scripts/server/purge-all-car-docs.sh
set -u
q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }

echo "== 0. before =="
q "SELECT '  CAR docs: ' || count(*) FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%'"
q "SELECT '  notifications: ' || count(*) FROM notifications WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%')"

echo "== 1. deleting car_assignments (trips/expenses cascade) =="
q "DELETE FROM car_assignments WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%') RETURNING id" | sed 's/^/  assignment /'

echo "== 2. notifications (ALL users — every CAR-related row) =="
q "WITH n AS (DELETE FROM notifications WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%') RETURNING 1) SELECT '  notifications: ' || count(*) FROM n"

echo "== 3. audit_logs for CAR docs =="
q "WITH a AS (DELETE FROM audit_logs WHERE \"recordId\"::text IN (SELECT id::text FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%') RETURNING 1) SELECT '  audit_logs: ' || count(*) FROM a"

echo "== 4. approval_actions =="
q "WITH a AS (DELETE FROM approval_actions WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%') RETURNING 1) SELECT '  approval_actions: ' || count(*) FROM a"

echo "== 5. attachments =="
q "WITH a AS (DELETE FROM attachments WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%') RETURNING 1) SELECT '  attachments: ' || count(*) FROM a"

echo "== 6. car_requests =="
q "DELETE FROM car_requests WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%') RETURNING id" | sed 's/^/  car_request /'

echo "== 7. request_documents =="
q "DELETE FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%' RETURNING \"docNumber\"" | sed 's/^/  doc /'

echo "== 8. restore fleet status =="
q "WITH v AS (UPDATE vehicles SET \"status\"='AVAILABLE' WHERE \"status\"='IN_USE' RETURNING 1) SELECT '  vehicles freed: ' || count(*) FROM v"
q "WITH d AS (UPDATE drivers SET \"status\"='AVAILABLE' WHERE \"status\"='ON_TRIP' RETURNING 1) SELECT '  drivers freed: ' || count(*) FROM d"

echo "== 9. reset CAR numbering counters (next doc starts at -0001) =="
q "DELETE FROM document_sequences WHERE \"key\" LIKE 'CAR-%' RETURNING \"key\"" | sed 's/^/  counter reset /'

echo "== 10. verify =="
q "SELECT '  CAR docs left: ' || count(*) FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%'"
q "SELECT '  car_requests left: ' || count(*) FROM car_requests"
q "SELECT '  car_assignments left: ' || count(*) FROM car_assignments"
q "SELECT '  CAR notifications left: ' || count(*) FROM notifications n WHERE n.\"requestId\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM request_documents d WHERE d.id::text = n.\"requestId\"::text)"
q "SELECT '  vehicles: ' || coalesce(string_agg(\"vehicleNo\" || '=' || status, ', '),'none') FROM vehicles"
q "SELECT '  drivers: ' || coalesce(string_agg(name || '=' || status, ', '),'none') FROM drivers"
echo "=== DONE — all CAR-* testing data purged ==="
