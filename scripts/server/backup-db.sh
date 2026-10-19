#!/usr/bin/env bash
# =============================================================
# AMS — PostgreSQL backup (spec v1.2 §50 "scheduled pg_dump")
#
# Dumps the PRODUCTION database (project "ams") inside the db container,
# gzip-compressed, with a retention window. Backups are the last line of
# defence for the append-only audit chain.
#
#   bash scripts/server/backup-db.sh          # one run (cron uses this)
#   KEEP_DAYS=30 bash scripts/server/backup-db.sh
#
# Cron (2026-10-19):  30 2 * * *
#   → 02:30 Asia/Yangon daily; logs + status written to /opt/admin/backups/
# =============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$DIR"

ENV_FILE=".env.prod"
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE missing"; exit 1; }
# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a

KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_DIR="$DIR/backups"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
TARGET="$BACKUP_DIR/ams-prod_$STAMP.sql.gz"

echo "[$(date '+%F %T')] backup start → $TARGET"

# pg_dump INSIDE the db container — credentials never leave the container env;
# write to a temp file then move, so a killed run never leaves a .gz that
# looks complete but is truncated.
docker exec ams-db-1 pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner \
  | gzip > "$TARGET.tmp"
mv "$TARGET.tmp" "$TARGET"

# integrity check: the gzip stream must decode cleanly and end with the
# complete-dump marker pg_dump writes near the end (PG 16 writes a final
# "\\unrestrict …" line / blank line after the marker — checked over the tail,
# not the literal last line).
if gzip -t "$TARGET" && gzip -cd "$TARGET" | tail -10 | grep -q "PostgreSQL database dump complete"; then
  SIZE="$(du -h "$TARGET" | cut -f1)"
  echo "[$(date '+%F %T')] backup OK ($SIZE)"
else
  echo "[$(date '+%F %T')] ERROR: dump incomplete or corrupt — removing $TARGET"
  rm -f "$TARGET"
  exit 1
fi

# retention: keep the newest KEEP_DAYS dumps, delete the rest
ls -1t "$BACKUP_DIR"/ams-prod_*.sql.gz 2>/dev/null | tail -n +$((KEEP_DAYS + 1)) | while read -r old; do
  echo "[$(date '+%F %T')] retention: deleting $old"
  rm -f "$old"
done

echo "[$(date '+%F %T')] backup done"
