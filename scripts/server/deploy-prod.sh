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

echo "== 2. Deploy PRODUCTION stack (project: ams — UI :80) =="
BUILD_FLAG="--build"
[ "${REBUILD:-1}" = "1" ] || BUILD_FLAG=""
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod up -d $BUILD_FLAG

echo "== 3. Health check =="
sleep 6
curl -fsS http://127.0.0.1:3000/api/health && echo
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod ps

echo "DONE — PRODUCTION UI: http://192.168.100.110/  (Testing on :8030; Ctrl+Shift+R after frontend deploys)"
