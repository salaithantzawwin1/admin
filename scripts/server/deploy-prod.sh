#!/usr/bin/env bash
# =============================================================
# AMS — Deploy PRODUCTION stack on 192.168.100.110
#
# PRODUCTION = project "ams" → UI http://192.168.100.110/ (:80)
# (Testing = project "ams-test" on :8030 — see deploy-testing.sh)
#
# Usage:
#   bash scripts/server/deploy-prod.sh              # pull + rebuild + health
#   NO_PULL=1 bash scripts/server/deploy-prod.sh    # deploy local edits
#   REBUILD=0 bash scripts/server/deploy-prod.sh    # up without rebuild
# =============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$DIR"

echo "== 1. Pre-flight =="
test -f .env.prod || { echo "ERROR: .env.prod missing in $DIR — create it (see env/)"; exit 1; }
# stale checkout = silently re-deploying old bugs (the CarPanel #310 lesson)
OLD_HEAD="$(git rev-parse --short HEAD)"
if [ "${NO_PULL:-0}" = "1" ]; then
  echo "   NO_PULL=1 — skipping git pull (deploying local checkout $OLD_HEAD)"
else
  git pull --ff-only origin main
fi
NEW_HEAD="$(git rev-parse --short HEAD)"
echo "   checkout: $OLD_HEAD -> $NEW_HEAD"
# Stamped into BOTH images at build time (compose.yaml build args) — the
# provenance check below asserts the running containers still carry it, so a
# cache-lie/stale image fails the deploy loudly instead of silently shipping
# older code (the CarPanel #310 lesson, the tb.js stale-bundle lesson).
export BUILD_COMMIT="$NEW_HEAD"

echo "== 1b. Archive the chunks of the build being replaced =="
# Every build gives the route chunks new hashes and the new image does not carry
# the old ones, so a tab that was opened before this deploy asks for a file that
# no longer exists: "Failed to fetch dynamically imported module", right in the
# middle of someone's form. Copy the outgoing build's assets into the archive
# nginx serves at /_archive/assets/ and let the app keep working until the tab is
# reloaded. -n never overwrites, so a hash keeps the copy of the build that
# actually shipped it; anything older than ARCHIVE_DAYS is pruned every deploy.
PC_PRE="docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod"
ARCHIVE_DAYS=4
if $PC_PRE exec -T frontend sh -c '
      days="$1"
      mountpoint -q /usr/share/nginx/html/_archive || exit 7
      mkdir -p /usr/share/nginx/html/_archive/assets
      cp -p -n /usr/share/nginx/html/assets/* /usr/share/nginx/html/_archive/assets/ 2>/dev/null
      find /usr/share/nginx/html/_archive/assets -type f -mtime +"$days" -delete 2>/dev/null
      echo "   archive: $(ls /usr/share/nginx/html/_archive/assets | wc -l) chunks kept (last $days days)"
    ' sh "$ARCHIVE_DAYS"; then
  :
else
  # First deploy that adds the mount: the running frontend predates it, so pull
  # the outgoing build out through docker cp instead of losing it.
  mkdir -p frontend/asset-archive/assets
  CID="$($PC_PRE ps -q frontend 2>/dev/null || true)"
  if [ -n "${CID:-}" ] && docker cp "$CID:/usr/share/nginx/html/assets/." frontend/asset-archive/assets/ 2>/dev/null; then
    echo "   archive: $(ls frontend/asset-archive/assets | wc -l) chunks kept (pulled from the outgoing container)"
  else
    echo "   nothing running to archive yet"
  fi
fi

echo "== 2. Deploy PRODUCTION stack (project: ams — UI :80) =="
BUILD_FLAG="--build"
[ "${REBUILD:-1}" = "1" ] || BUILD_FLAG=""
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod up -d $BUILD_FLAG

echo "== 3. Health check =="
sleep 6
curl -fsS http://127.0.0.1:3000/api/health && echo
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod ps

echo
echo "== 4. Build provenance (stale-image guard) =="
PC="docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod"
BACK_STAMP="$($PC exec -T backend cat /app/dist/BUILD_COMMIT 2>/dev/null || echo MISSING)"
FRONT_STAMP="$($PC exec -T frontend cat /BUILD_COMMIT 2>/dev/null || echo MISSING)"
echo "   checkout: $NEW_HEAD   backend image: $BACK_STAMP   frontend image: $FRONT_STAMP"
if [ "$BACK_STAMP" != "$NEW_HEAD" ] || [ "$FRONT_STAMP" != "$NEW_HEAD" ]; then
  echo "ERROR: running artifacts were NOT built from checkout $NEW_HEAD — stale image detected!"
  echo "       rebuild with: $PC build --no-cache && $PC up -d"
  exit 1
fi
echo "   OK — both images built from this checkout"

echo "DONE — PRODUCTION UI: http://192.168.100.110/  (Testing on :8030; Ctrl+Shift+R after frontend deploys)"
