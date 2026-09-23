#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%car%';
SELECT "requestId", "vehicleId", status, "startDate", "endDate" FROM car_requests ORDER BY "updatedAt" DESC LIMIT 4;
SELECT id, "requestId", "vehicleId", "releasedAt" FROM car_assignments ORDER BY "assignedAt" DESC LIMIT 3;
SELECT "docNumber", status FROM request_documents WHERE "docType"='CAR_REQUEST' ORDER BY "updatedAt" DESC LIMIT 4;
SQL
