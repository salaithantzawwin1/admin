#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
\echo === 1) repair stale cancelled car requests (mirror new admin-cancel behavior) ===
UPDATE car_assignments ca SET "releasedAt" = now()
FROM car_requests cr JOIN request_documents rd ON rd.id = cr."requestId"
WHERE ca."requestId" = cr."requestId" AND ca."releasedAt" IS NULL AND rd.status = 'CANCELLED';

UPDATE car_requests cr SET "vehicleId" = NULL, "driverId" = NULL, status = 'CANCELLED'
FROM request_documents rd WHERE rd.id = cr."requestId" AND rd.status = 'CANCELLED';

\echo === 2) free vehicles/drivers whose only active booking was cancelled ===
UPDATE vehicles v SET status = 'AVAILABLE'
WHERE v.status = 'IN_USE' AND NOT EXISTS (
  SELECT 1 FROM car_requests cr WHERE cr."vehicleId" = v.id
    AND cr.status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS'));

UPDATE drivers d SET status = 'AVAILABLE'
WHERE d.status = 'ON_TRIP' AND NOT EXISTS (
  SELECT 1 FROM car_requests cr WHERE cr."driverId" = d.id
    AND cr.status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS'));

\echo === 3) delete E2E test documents (CAR-2026-0003/0004/0005) children first ===
DELETE FROM car_trips WHERE "assignmentId" IN (
  SELECT ca.id FROM car_assignments ca JOIN request_documents rd ON rd.id = ca."requestId"
  WHERE rd."docNumber" IN ('CAR-2026-0003','CAR-2026-0004','CAR-2026-0005'));
DELETE FROM car_assignments WHERE "requestId" IN (
  SELECT id FROM request_documents WHERE "docNumber" IN ('CAR-2026-0003','CAR-2026-0004','CAR-2026-0005'));
DELETE FROM car_requests WHERE "requestId" IN (
  SELECT id FROM request_documents WHERE "docNumber" IN ('CAR-2026-0003','CAR-2026-0004','CAR-2026-0005'));
DELETE FROM notifications WHERE "requestId" IN (
  SELECT id FROM request_documents WHERE "docNumber" IN ('CAR-2026-0003','CAR-2026-0004','CAR-2026-0005'));
DELETE FROM approval_actions WHERE "requestId" IN (
  SELECT id FROM request_documents WHERE "docNumber" IN ('CAR-2026-0003','CAR-2026-0004','CAR-2026-0005'));
DELETE FROM attachments WHERE "requestId" IN (
  SELECT id FROM request_documents WHERE "docNumber" IN ('CAR-2026-0003','CAR-2026-0004','CAR-2026-0005'));
DELETE FROM request_documents WHERE "docNumber" IN ('CAR-2026-0003','CAR-2026-0004','CAR-2026-0005');

\echo === 4) final state ===
SELECT rd."docNumber", rd.status, cr.status AS car_status, cr."vehicleId" IS NOT NULL AS has_vehicle
FROM request_documents rd LEFT JOIN car_requests cr ON cr."requestId" = rd.id
WHERE rd."docType" = 'CAR_REQUEST' ORDER BY rd."docNumber";
SELECT "vehicleNo", status FROM vehicles ORDER BY "vehicleNo";
SELECT name, status FROM drivers ORDER BY name;
SQL
