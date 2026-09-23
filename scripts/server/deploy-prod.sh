#!/usr/bin/env bash
# =============================================================
# AMS — Deploy to Production server (192.168.100.101)
#
# Copies the project over SSH (no SMB/network drive needed — plain scp),
# builds and starts the production stack.
#
# Usage:
#   bash scripts/server/deploy-prod.sh              # full deploy (sync + build + up)
#   SKIP_SYNC=1 bash scripts/server/deploy-prod.sh  # build + up only
#   HOST=192.168.100.101 USER=glgadmin bash scripts/server/deploy-prod.sh
#
# Prerequisites:
#   - SSH access to the prod server (key-based or type password when asked)
#   - .env.prod on the prod server (copy from .env.prod.example, set secrets)
#   - Docker + compose plugin on the prod server
# =============================================================
set -euo pipefail

HOST="${HOST:-192.168.100.101}"
USER="${USER:-glgadmin}"
REMOTE_DIR="${REMOTE_DIR:-/opt/admin}"
TARGET="${USER}@${HOST}"

echo "== 1. Pre-flight (local) =="
# node/tsc only exist on dev machines — when deploying from a server host
# (where node runs inside Docker only) skip the typecheck gracefully.
if command -v node >/dev/null 2>&1 && [ -f backend/node_modules/typescript/bin/tsc ] && [ -f frontend/node_modules/typescript/bin/tsc ]; then
  node backend/node_modules/typescript/bin/tsc --noEmit -p backend/tsconfig.json
  node frontend/node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json
  echo "typecheck OK"
else
  echo "node/tsc not available on this host — skipping typecheck (typecheck on a dev machine before pushing)"
fi

echo "== 2. Sync project to ${TARGET}:${REMOTE_DIR} (rsync over SSH) =="
if [ "${SKIP_SYNC:-0}" != "1" ]; then
  ssh "$TARGET" "mkdir -p '$REMOTE_DIR'"
  rsync -az --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'backend/dist' \
    --exclude 'frontend/dist' \
    --exclude '.env.test' \
    --exclude '.env.prod' \
    ./ "$TARGET:$REMOTE_DIR/"
  echo "sync done"
else
  echo "SKIP_SYNC=1 — using existing sources on server"
fi

echo "== 3. Ensure .env.prod exists on server =="
ssh "$TARGET" "cd '$REMOTE_DIR' && test -f .env.prod || { echo 'ERROR: .env.prod missing — copy .env.prod.example to .env.prod and set secrets'; exit 1; }"

echo "== 4. Build & start production stack =="
ssh -t "$TARGET" "cd '$REMOTE_DIR' && docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod up -d --build"

echo "== 5. Health check =="
sleep 6
ssh "$TARGET" "curl -fsS http://localhost:3000/api/health && echo && docker compose -f '$REMOTE_DIR/compose.yaml' -f '$REMOTE_DIR/compose.prod.yaml' --env-file '$REMOTE_DIR/.env.prod' ps"

echo "DONE — UI: http://${HOST}:3000  (testing stays on :8080)"
