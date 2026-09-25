#!/bin/bash
# One-shot: align the postgres role password with .env.prod (run on the server).
# Background: POSTGRES_PASSWORD only applies when the data volume is FIRST
# initialized; on an existing volume the role keeps its original password and
# the backend's DATABASE_URL (built from the env file) fails with P1000.
set -e
DB=${1:-ams-db-1}
EPW=$(grep -E '^POSTGRES_PASSWORD' /opt/admin/.env.prod | cut -d= -f2-)
docker exec "$DB" psql -U ams -d ams -c "ALTER USER ams WITH PASSWORD '$EPW';"
echo "PASSWORD-UPDATED on $DB"
