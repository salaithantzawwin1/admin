#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
-- clean up any partial objects from the failed migration (idempotent)
DROP TABLE IF EXISTS meeting_room_requests CASCADE;
DROP TABLE IF EXISTS meeting_rooms CASCADE;
DROP TYPE IF EXISTS "MeetingRoomStatus";

DELETE FROM _prisma_migrations WHERE migration_name = '00000000000009_meeting_rooms';
SQL
docker exec ams-backend-1 sh -c "npx prisma migrate deploy" 2>&1 | tail -4
