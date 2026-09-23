#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
\echo === delete meeting E2E test docs ===
DELETE FROM meeting_room_requests WHERE "requestId" IN (
  SELECT id FROM request_documents WHERE "docNumber" IN ('MTG-202609-0001','MTG-202609-0002'));
DELETE FROM notifications WHERE "requestId"::text IN (
  SELECT id::text FROM request_documents WHERE "docNumber" IN ('MTG-202609-0001','MTG-202609-0002'));
DELETE FROM approval_actions WHERE "requestId" IN (
  SELECT id FROM request_documents WHERE "docNumber" IN ('MTG-202609-0001','MTG-202609-0002'));
DELETE FROM request_documents WHERE "docNumber" IN ('MTG-202609-0001','MTG-202609-0002');

\echo === free rooms still marked IN_USE without live bookings ===
UPDATE meeting_rooms r SET status = 'AVAILABLE' WHERE r.status = 'IN_USE'
  AND NOT EXISTS (SELECT 1 FROM meeting_room_requests mr WHERE mr."roomId" = r.id
                  AND mr.status IN ('PENDING_APPROVAL','APPROVED','IN_PROGRESS'));

\echo === reset MTG sequence ===
DELETE FROM document_sequences WHERE "key" LIKE 'MTG-%';

\echo === final state ===
SELECT count(*) AS remaining_meeting_requests FROM meeting_room_requests;
SELECT count(*) AS remaining_requests FROM request_documents;
SELECT name, status FROM meeting_rooms ORDER BY name;
SQL
