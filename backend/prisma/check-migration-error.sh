#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
SELECT migration_name, finished_at, logs IS NOT NULL AS has_logs, left(logs, 500) AS error_snippet
FROM _prisma_migrations WHERE migration_name LIKE '%meeting%' ORDER BY started_at DESC LIMIT 3;
SQL
