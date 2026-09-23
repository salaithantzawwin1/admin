#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
\echo === cleanup test data ===
DELETE FROM vehicles WHERE "vehicleNo" = 'TEST-001';
DELETE FROM drivers WHERE name = 'Test Driver';
DELETE FROM meeting_room_requests WHERE "requestId" IN (
  SELECT id FROM request_documents WHERE title LIKE '%Req Fields Test%' OR title LIKE '%E2E%');
DELETE FROM notifications WHERE "requestId"::text IN (
  SELECT id::text FROM request_documents WHERE title LIKE '%Req Fields Test%' OR title LIKE '%E2E%');
DELETE FROM approval_actions WHERE "requestId" IN (
  SELECT id FROM request_documents WHERE title LIKE '%Req Fields Test%' OR title LIKE '%E2E%');
DELETE FROM request_documents WHERE title LIKE '%Req Fields Test%' OR title LIKE '%E2E%';
DELETE FROM meeting_rooms WHERE name = 'Test Room Z';

\echo === final state ===
SELECT "vehicleNo" FROM vehicles ORDER BY "vehicleNo";
SELECT name FROM drivers ORDER BY name;
SELECT name, status FROM meeting_rooms ORDER BY name;
SELECT count(*) AS remaining_requests FROM request_documents;
SQL
