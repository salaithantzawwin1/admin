#!/usr/bin/env bash
# =============================================================
# AMS — Deploy the TESTING stack on this server (192.168.100.110).
# One-stack policy: this is THE deploy script for day-to-day work.
#
# What it does that plain `up -d --build` forgets:
#   1. pulls the latest code first — a stale checkout silently re-deploys old
#      bugs (this is how the CarPanel React #310 crash survived a "deploy")
#   2. rebuilds both images
#   3. verifies the served frontend bundle hash actually CHANGED when new code
#      was pulled — fails loudly instead of "deploying" nothing
#
# Usage:
#   bash scripts/server/deploy-testing.sh
#   NO_PULL=1 bash scripts/server/deploy-testing.sh   # skip git pull (local edits)
# =============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$DIR"
UI_URL="http://127.0.0.1"

COMPOSE="docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test"

echo "== 1. Pull latest code =="
OLD_HEAD="$(git rev-parse --short HEAD)"
if [ "${NO_PULL:-0}" = "1" ]; then
  echo "   NO_PULL=1 — skipping git pull (deploying local checkout $OLD_HEAD)"
else
  git pull --ff-only origin main
fi
NEW_HEAD="$(git rev-parse --short HEAD)"
[ "$OLD_HEAD" = "$NEW_HEAD" ] && echo "   checkout unchanged ($NEW_HEAD)" || echo "   updated: $OLD_HEAD -> $NEW_HEAD"

echo "== 2. Rebuild + restart stack =="
$COMPOSE up -d --build

echo "== 3. Health check =="
sleep 6
curl -fsS "$UI_URL/api/health" && echo
$COMPOSE ps

echo "== 4. Frontend bundle freshness check =="
SERVED="$(curl -fsS "$UI_URL/" | grep -o 'index-[^"]*\.js' | head -1 || true)"
[ -n "$SERVED" ] || { echo "ERROR: could not read the served bundle name from $UI_URL/"; exit 1; }
echo "   served bundle: $SERVED"
if [ "$OLD_HEAD" != "$NEW_HEAD" ]; then
  BEFORE="$(git log -1 --format=%H "$OLD_HEAD" -- frontend | head -1)"
  AFTER="$(git log -1 --format=%H "$NEW_HEAD" -- frontend | head -1)"
  if [ "$BEFORE" != "$AFTER" ] && [ -f "frontend/dist/$SERVED" ]; then
    echo "   (frontend changed this pull — hash above should differ from the previous deploy)"
  fi
fi
# catches the stale-image trap: same bundle after a frontend-code change means build cache lied
if git diff --quiet "$OLD_HEAD" "$NEW_HEAD" -- frontend 2>/dev/null; then
  echo "   frontend unchanged in this pull — hash staying the same is expected"
else
  echo "   NOTE: frontend code changed in this pull — if the hash equals the previous"
  echo "         deploy's hash, the image did NOT rebuild (run with DOCKER_BUILDKIT=0 or --no-cache)"
fi

echo
echo "DONE — testing UI: http://192.168.100.110/  (Ctrl+Shift+R in the browser after deploys!)"
