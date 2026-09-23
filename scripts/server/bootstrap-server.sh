#!/usr/bin/env bash
# =============================================================
# AMS Server Bootstrap — installs Docker Engine + Compose plugin
# Target: Ubuntu 22.04 (adminsrv / 192.168.100.110)
# Run as:  PW='...' bash scripts/server/bootstrap-server.sh   (password via env)
#          or after key-setup: HOST=... USER=... bash scripts/server/bootstrap-server.sh
# NOTE: never hardcode the server password here — this file is committed.
# =============================================================
set -euo pipefail

PW="${PW:?Provide the server password: PW='...' bash $0}"
HOST="${HOST:-192.168.100.110}"
SSH_USER="${SSH_USER:-glgadmin}"

run() {
  if [ -n "${USE_PLINK:-}" ]; then
    plink -ssh "$SSH_USER@$HOST" -pw "$PW" "$1"
  else
    ssh "$SSH_USER@$HOST" "$1"
  fi
}

# remote sudo helper: runs 'echo PW | sudo -S ...' on the server
srun() {
  run "echo '$PW' | sudo -S -p '' $1"
}

echo "== [1/5] Installing prerequisites =="
run "set -e"
run "sudo -k"
srun "apt-get update -y"
srun "apt-get install -y ca-certificates curl gnupg lsb-release"

echo "== [2/5] Adding Docker GPG key & repository =="
run "sudo -k"
srun "install -m 0755 -d /etc/apt/keyrings"
run "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /tmp/docker.gpg"
srun "gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg"
srun "chmod a+r /etc/apt/keyrings/docker.gpg"
srun "bash -c \"echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable' > /etc/apt/sources.list.d/docker.list\""

echo "== [3/5] Installing Docker Engine + Compose plugin =="
run "sudo -k"
srun "apt-get update -y"
srun "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"

echo "== [4/5] Enabling & starting Docker =="
run "sudo -k"
srun "systemctl enable --now docker"

echo "== [5/5] Adding $SSH_USER to docker group =="
run "sudo -k"
srun "usermod -aG docker $SSH_USER"

run "docker --version && docker compose version"
echo "BOOTSTRAP COMPLETE"
