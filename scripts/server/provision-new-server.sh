#!/usr/bin/env bash
# =============================================================
# AMS — Provision a NEW server for deployment (physical or VM)
#
# Prepares a fresh Ubuntu 22.04 machine so it is "ready to deploy":
#   1. Docker Engine + Compose plugin
#   2. User added to the docker group
#   3. SSH key installed (passwordless deploys from the dev machine)
#   4. Project checkout at /opt/admin (from GitHub)
#   5. .env.<env> placeholder check (secrets are never in git)
#   6. Stack up + health check (optional: PROVISION_DEPLOY=1)
#
# Run from the Windows dev machine (Git Bash):
#   NEW_HOST=192.168.100.150 NEW_USER=glgadmin PW='...' \
#     bash scripts/server/provision-new-server.sh
#
#   Optional env vars:
#     PROVISION_DEPLOY=1   also build & start the testing stack after setup
#     SETUP_ENV=test|prod  which env file to check/create (default test)
# =============================================================
set -euo pipefail

NEW_HOST="${NEW_HOST:?Usage: NEW_HOST=<ip> NEW_USER=<user> PW='<password>' bash $0}"
NEW_USER="${NEW_USER:-glgadmin}"
PW="${PW:?Provide the new server password: PW='...' bash $0}"
SETUP_ENV="${SETUP_ENV:-test}"
REPO="https://github.com/salaithantzawwin1/admin.git"

PUB_KEY="$(cat ~/.ssh/id_ed25519.pub 2>/dev/null || true)"
if [ -z "$PUB_KEY" ]; then
  echo "No ~/.ssh/id_ed25519.pub found — generate one first: ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519"
  exit 1
fi

R() { ssh -o StrictHostKeyChecking=accept-new "$NEW_USER@$NEW_HOST" "$1"; }
RS() { R "echo '$PW' | sudo -S -p '' $1"; }

echo "== [1/6] Docker Engine + Compose =="
R "command -v docker >/dev/null && docker compose version >/dev/null" && echo "docker already installed" || {
  RS "apt-get update -y"
  RS "apt-get install -y ca-certificates curl gnupg lsb-release"
  RS "install -m 0755 -d /etc/apt/keyrings"
  R "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /tmp/docker.gpg"
  RS "gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg && chmod a+r /etc/apt/keyrings/docker.gpg"
  RS "bash -c \"echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable' > /etc/apt/sources.list.d/docker.list\""
  RS "apt-get update -y"
  RS "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  RS "systemctl enable --now docker"
}
RS "usermod -aG docker $NEW_USER"

echo "== [2/6] SSH key install (passwordless from this machine) =="
R "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF '$PUB_KEY' ~/.ssh/authorized_keys 2>/dev/null || echo '$PUB_KEY' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys"
ssh -o BatchMode=yes "$NEW_USER@$NEW_HOST" "echo key-auth-OK" && echo "key auth works" \
  || echo "WARN: key auth not active yet — log in once with password, then retry"

echo "== [3/6] Project checkout at /opt/admin =="
RS "mkdir -p /opt/admin && chown $NEW_USER:$NEW_USER /opt/admin"
R "cd /opt/admin && (git remote get-url origin >/dev/null 2>&1 || git init -b main) && git remote add origin $REPO 2>/dev/null; git fetch origin main && (git checkout -f main 2>/dev/null || git reset --hard origin/main) && git log --oneline -1"
RS "git config --global --add safe.directory /opt/admin || true" # (safe.directory is per-user; also set for the deploy user below)
R "git config --global --add safe.directory /opt/admin"

echo "== [4/6] Environment file check (.env.$SETUP_ENV) =="
R "cd /opt/admin && test -f .env.$SETUP_ENV && echo '.env.$SETUP_ENV already present — keep it' || { cp env/.env.$SETUP_ENV.example .env.$SETUP_ENV && echo 'CREATED .env.$SETUP_ENV from template — EDIT SECRETS NOW: nano /opt/admin/.env.$SETUP_ENV'; }"

echo "== [5/6] Summary =="
R "docker --version && docker compose version && free -h | head -2 && df -h / | tail -1"

if [ "${PROVISION_DEPLOY:-0}" = "1" ]; then
  echo "== [6/6] Building & starting the $SETUP_ENV stack =="
  if [ "$SETUP_ENV" = "prod" ]; then
    R "cd /opt/admin && docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod up -d --build && sleep 6 && curl -fsS http://127.0.0.1:3010/api/health"
    echo "DONE — prod UI: http://$NEW_HOST:3080"
  else
    R "cd /opt/admin && docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test up -d --build && sleep 6 && curl -fsS http://127.0.0.1:80/api/health"
    echo "DONE — testing UI: http://$NEW_HOST/ (plain port 80)"
  fi
else
  echo "== [6/6] skipped (set PROVISION_DEPLOY=1 to also start the stack) =="
fi

echo
echo "NEXT STEPS:"
echo "  1. Edit secrets on the new server:  nano /opt/admin/.env.$SETUP_ENV"
echo "     (POSTGRES_PASSWORD, JWT_SECRET, SEED_PASSWORD — use DIFFERENT values than 110!)"
echo "  2. Start the stack (see docs/DEPLOYMENT.md §Deploy elsewhere)"
echo "  3. Health check: curl http://$NEW_HOST/api/health  (or :3010 for prod backend)"
