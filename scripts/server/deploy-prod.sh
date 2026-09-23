#!/usr/bin/env bash
# =============================================================
# AMS — Deploy PRODUCTION stack on THIS server (192.168.100.110)
#
# There is only one server: prod runs alongside the testing stack
# as project "ams-prod" (own network + volumes, UI on :3080).
#
# Usage:
#   bash scripts/server/deploy-prod.sh              # deploy prod stack
#   REBUILD=0 bash scripts/server/deploy-prod.sh    # up without rebuild
#
# Prerequisites:
#   - /opt/admin/.env.prod (secrets) — checked below
#   - Docker + compose plugin
# =============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$DIR"

echo "== 1. Pre-flight =="
test -f .env.prod || { echo "ERROR: .env.prod missing in $DIR — create it (see .env.prod.example)"; exit 1; }
if command -v node >/dev/null 2>&1 && [ -f backend/node_modules/typescript/bin/tsc ]; then
  node backend/node_modules/typescript/bin/tsc --noEmit -p backend/tsconfig.json && echo "typecheck OK"
else
  echo "node not on host — skipping typecheck (build happens in Docker)"
fi

echo "== 2. Deploy production stack (project: ams-prod) =="
BUILD_FLAG=""
[ "${REBUILD:-1}" = "1" ] && BUILD_FLAG="--build"
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod up -d $BUILD_FLAG

echo "== 3. Health check =="
sleep 6
curl -fsS http://127.0.0.1:3010/api/health && echo
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod ps

echo "DONE — prod UI: http://192.168.100.110:3080  (testing keeps :80/:8080)"
