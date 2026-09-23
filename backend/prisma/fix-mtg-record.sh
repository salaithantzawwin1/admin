#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
UPDATE request_documents SET "currentLevel" = 1, "totalLevels" = 1
WHERE id = '67e0d712-2165-46de-bf9d-6725e5452420' AND status = 'PENDING_APPROVAL';
SELECT "docNumber", status, "currentLevel", "totalLevels" FROM request_documents
WHERE id = '67e0d712-2165-46de-bf9d-6725e5452420';
SQL
