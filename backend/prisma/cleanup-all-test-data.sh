#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
\echo === before: all request documents ===
SELECT "docType", "docNumber", status FROM request_documents ORDER BY "docNumber";

\echo === delete ALL test request documents + children (test environment) ===
DELETE FROM car_trips WHERE "assignmentId" IN (
  SELECT ca.id FROM car_assignments ca JOIN request_documents rd ON rd.id = ca."requestId");
DELETE FROM car_expenses WHERE "tripId" NOT IN (SELECT id FROM car_trips);
DELETE FROM car_assignments;
DELETE FROM car_requests;
DELETE FROM notifications WHERE "requestId"::text IN (SELECT id::text FROM request_documents);
DELETE FROM approval_actions;
DELETE FROM attachments;
DELETE FROM request_documents;

\echo === free all vehicles/drivers (no active bookings remain) ===
UPDATE vehicles SET status='AVAILABLE' WHERE status='IN_USE';
UPDATE drivers SET status='AVAILABLE' WHERE status='ON_TRIP';

\echo === reset doc sequences (new month format starts fresh) ===
DELETE FROM document_sequences WHERE "key" LIKE 'CAR-%';

\echo === after: state check ===
SELECT count(*) AS remaining_requests FROM request_documents;
SELECT "vehicleNo", status FROM vehicles ORDER BY "vehicleNo";
SELECT name, status FROM drivers ORDER BY name;
SELECT "key", counter FROM document_sequences;
SQL
