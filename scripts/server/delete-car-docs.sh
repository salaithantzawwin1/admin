#!/usr/bin/env bash
# =============================================================
# Delete car request documents (by doc number) with every related row.
#
# Targets the PRODUCTION stack (project ams — container ams-db-1, UI :80)
# by default; pass --testing for the testing stack (ams-test-db-1, UI :8030).
#
# Usage:
#   bash scripts/server/delete-car-docs.sh CAR-202609-0035 [CAR-202609-0036 ...]
#   bash scripts/server/delete-car-docs.sh --testing CAR-202609-0035
#   bash scripts/server/delete-car-docs.sh --all-testing   # wipe ALL car docs (testing only)
#
# FK-safe order: car_expenses → car_trips → car_assignments → notifications →
# audit_logs → approval_actions → attachments → car_requests → request_documents
# =============================================================
set -u

STACK="--prod"; DOCS=(); WIPE_ALL=0
for a in "$@"; do
  case "$a" in
    --prod) STACK="--prod" ;;
    --testing) STACK="--testing" ;;
    --all-testing) WIPE_ALL=1 ;;
    *) DOCS+=("$a") ;;
  esac
done

if [ "$STACK" = "--testing" ]; then
  DB_CONTAINER="ams-test-db-1"
  UI="http://192.168.100.110:8030"
else
  DB_CONTAINER="ams-db-1"
  UI="http://192.168.100.110/"
fi
echo "Target stack: $STACK ($DB_CONTAINER — UI $UI)"

q() { printf '%s\n' "$1" | docker exec -i "$DB_CONTAINER" sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }

if [ "$WIPE_ALL" = "1" ]; then
  if [ "$STACK" = "--prod" ]; then echo "ERROR: --all-testing is testing-only"; exit 1; fi
  echo "— wiping ALL car request documents (testing):"
  q "DELETE FROM car_expenses" >/dev/null
  q "DELETE FROM car_trips"    >/dev/null
  q "DELETE FROM car_assignments" >/dev/null
  q "DELETE FROM notifications WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docType\" = 'CAR_REQUEST')" >/dev/null
  q "DELETE FROM audit_logs WHERE \"recordId\"::text IN (SELECT id::text FROM request_documents WHERE \"docType\" = 'CAR_REQUEST')" >/dev/null
  q "DELETE FROM approval_actions WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docType\" = 'CAR_REQUEST')" >/dev/null
  q "DELETE FROM attachments WHERE \"requestId\" IN (SELECT id FROM request_documents WHERE \"docType\" = 'CAR_REQUEST')" >/dev/null
  q "DELETE FROM car_requests" >/dev/null
  q "DELETE FROM request_documents WHERE \"docType\" = 'CAR_REQUEST'" >/dev/null
  echo "  done"
else
  [ ${#DOCS[@]} -eq 0 ] && { echo "Usage: bash scripts/server/delete-car-docs.sh [--prod|--testing] CAR-... [CAR-...] | --all-testing"; exit 1; }
  DOCS_SQL=$(printf "'%s'," "${DOCS[@]}" | sed 's/,$//')
  SEL="(SELECT id FROM request_documents WHERE \"docNumber\" IN ($DOCS_SQL))"

  echo "— deleting related rows:"
  q "DELETE FROM car_expenses WHERE \"tripId\" IN (SELECT t.id FROM car_trips t JOIN car_assignments a ON a.id = t.\"assignmentId\" WHERE a.\"requestId\" IN $SEL) RETURNING id" | sed 's/^/  car_expense /'
  q "DELETE FROM car_trips WHERE \"assignmentId\" IN (SELECT id FROM car_assignments WHERE \"requestId\" IN $SEL) RETURNING id" | sed 's/^/  car_trip /'
  q "DELETE FROM car_assignments WHERE \"requestId\" IN $SEL RETURNING id" | sed 's/^/  car_assignment /'
  q "WITH n AS (DELETE FROM notifications WHERE \"requestId\"::text IN (SELECT id::text FROM request_documents WHERE \"docNumber\" IN ($DOCS_SQL)) RETURNING 1) SELECT '  notifications: ' || count(*) FROM n"
  q "WITH a AS (DELETE FROM audit_logs WHERE \"recordId\"::text IN (SELECT id::text FROM request_documents WHERE \"docNumber\" IN ($DOCS_SQL)) RETURNING 1) SELECT '  audit_logs: ' || count(*) FROM a"
  q "WITH a AS (DELETE FROM approval_actions WHERE \"requestId\" IN $SEL RETURNING 1) SELECT '  approval_actions: ' || count(*) FROM a"
  q "WITH at AS (DELETE FROM attachments WHERE \"requestId\" IN $SEL RETURNING 1) SELECT '  attachments: ' || count(*) FROM at"
  q "DELETE FROM car_requests WHERE \"requestId\" IN $SEL RETURNING id" | sed 's/^/  car_request /'
  q "DELETE FROM request_documents WHERE \"docNumber\" IN ($DOCS_SQL) RETURNING \"docNumber\"" | sed 's/^/  request_document /'
fi

echo "— verify:"
q "SELECT '  CAR docs left: ' || count(*) FROM request_documents WHERE \"docNumber\" LIKE 'CAR-%'"
q "SELECT '  car_requests left: ' || count(*) FROM car_requests"
q "SELECT '  car_assignments left: ' || count(*) FROM car_assignments"
q "SELECT '  car_trips left: ' || count(*) FROM car_trips"
q "SELECT '  car_expenses left: ' || count(*) FROM car_expenses"
q "SELECT '  vehicles: ' || COALESCE(string_agg(\"vehicleNo\" || '=' || status, ', '), '(none)') FROM vehicles"
echo "=== DONE ($UI) ==="
