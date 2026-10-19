#!/usr/bin/env bash
# =============================================================
# AMS — PostgreSQL RESTORE (companion to backup-db.sh)
#
#   bash scripts/server/restore-db.sh backups/ams-prod_2026-10-19_*.sql.gz
#
# DESTRUCTIVE: drops and recreates the PRODUCTION database inside the
# ams-db-1 container from the given dump. Requires the explicit word
# "RESTORE" as the second argument as a typo guard.
#
#   bash scripts/server/restore-db.sh <dumpfile> RESTORE
# =============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$DIR"

DUMP="${1:-}"
CONFIRM="${2:-}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "usage: $0 <backup.sql.gz> RESTORE"; exit 1; }
[ "$CONFIRM" = "RESTORE" ] || { echo "REFUSING: pass the literal word RESTORE as the 2nd argument to confirm."; exit 1; }

ENV_FILE=".env.prod"
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE missing"; exit 1; }
# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a

echo "Restoring $DUMP into database '$POSTGRES_DB' (container ams-db-1)…"
gzip -cd "$DUMP" | docker exec -i ams-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -v ON_ERROR_STOP=1 \
  && echo "RESTORE OK — restart the backend so connections re-establish:" \
  && echo "  docker restart ams-backend-1" \
  || { echo "RESTORE FAILED — psql aborted on error (dump may not match this schema)."; exit 1; }
