#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
\echo === seed MEETING_ROOM_REQUEST workflow (L1 ADMINISTRATION) ===
INSERT INTO approval_workflows ("id", "module", "name", "active", "updatedAt")
SELECT gen_random_uuid(), 'MEETING_ROOM_REQUEST', 'Meeting Room Request — Administration approval', true, now()
WHERE NOT EXISTS (SELECT 1 FROM approval_workflows WHERE module = 'MEETING_ROOM_REQUEST');

INSERT INTO approval_steps ("id", "workflowId", "level", "roleName", "minApprovals", "createdAt")
SELECT gen_random_uuid(), w.id, 1, 'ADMINISTRATION', 1, now()
FROM approval_workflows w
WHERE w.module = 'MEETING_ROOM_REQUEST'
  AND NOT EXISTS (SELECT 1 FROM approval_steps s WHERE s."workflowId" = w.id AND s.level = 1);

\echo === verify ===
SELECT w.module, s.level, s."roleName" FROM approval_workflows w
JOIN approval_steps s ON s."workflowId" = w.id
WHERE w.module IN ('CAR_REQUEST','MEETING_ROOM_REQUEST') ORDER BY w.module, s.level;
SQL
