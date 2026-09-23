# AMS — Development & Deployment Guide

> Last updated: 2026-09-23 (single-server topology + future-server playbook)
> Verified on: adminsrv (192.168.100.110, Ubuntu 22.04.5 LTS VM, Docker 29.8.1, Compose v5.5.1)

## 1. Servers & topology

**There is ONE server today** — a VM. The plan: develop/test/stage here, and when
everything is finished, deploy the same code to a **physical server** (§8).

| | Current VM (dev + test + prod-as-VM) | Future physical server |
|---|---|---|
| IP | `192.168.100.110` (adminsrv) | TBD — provision with §8 |
| OS | Ubuntu 22.04.5 LTS | Ubuntu 22.04 (recommended) |
| User | `glgadmin` | `glgadmin` (or any sudo user) |
| Roles | **Development + Testing + Production (VM)** | Production only |
| SSH | ✅ key-based (§3) | set up by `provision-new-server.sh` |

**Code is always deploy-ready**: everything needed to rebuild any environment
lives in git (GitHub `salaithantzawwin1/admin`, branch `main`) + the `.env.*`
secrets that live only on servers (never in git).

### Current stacks on 192.168.100.110 (side by side, isolated)

| Stack | Project | Compose files | UI | Backend (loopback) | Data volumes |
|---|---|---|---|---|---|
| Testing | `ams` | `compose.yaml` + `compose.test.yaml` + `.env.test` | `:80` and `:8080` | `127.0.0.1:3000` | `ams_db_data`, `ams_uploads_data` |
| Production (VM) | `ams-prod` | `compose.yaml` + `compose.prod.yaml` + `.env.prod` | `:3080` | `127.0.0.1:3010` | `ams-prod_db_data`, `ams-prod_uploads_data` |

The two stacks share nothing: separate compose project names → separate networks
and volumes. Port conflicts are impossible by design.

## 2. Samba share = the same files

`\\192.168.100.110\admin` (Windows drive **Y:**) **is** `/opt/admin` on the server —
one copy of the files. Editing from Windows edits the server copy instantly.

Consequences:
- **No copy step needed** for deploys on 110. Build/run must happen on the server
  (node/npm only run inside Docker there — the host has no node).
- The **git repo lives on the share too** (`.git` inside Y:). One caveat: git index
  writes over SMB can occasionally misbehave — if `git status` ever looks wrong,
  re-run it, or work from a server SSH shell.

## 3. SSH access

- Key auth installed for `glgadmin@192.168.100.110` (ed25519 `codebuff@ams-dev`,
  Windows dev machine): `ssh glgadmin@192.168.100.110` — no password.
- PuTTY `plink` available on the Windows machine as a fallback.
- Hardening recommendation: switch the server to key-only auth (`sshd_config`:
  `PasswordAuthentication no`) and change the shared password.
- **The server password must never be committed** — pass it via env var to
  scripts (`PW='...' bash scripts/server/bootstrap-server.sh`).

## 4. Git workflow

- Remote: `https://github.com/salaithantzawwin1/admin.git` (branch `main`)
- Identity (repo-local): `salaithantzawwin1` / `salaithantzawwin1@users.noreply.github.com`
- **Secrets are never committed**: `.env.test`, `.env.prod`, `.env` are gitignored;
  only `env/*.example` templates are in the repo.

First-time on a fresh clone/checkout:
```bash
git config --global --add safe.directory /opt/admin   # if "dubious ownership" error
cp env/.env.test.example .env.test                     # then edit secrets (server only)
```

Daily flow:
```bash
# edit files (Y: drive or any editor)
git add <files> && git commit -m "..." && git push
```

## 5. Deploy — Testing (on 110)

```bash
cd /opt/admin
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test up -d --build
```

- `--build` needed when code changed; plain `up -d` suffices for port/env-only changes.
- Migrations + seed run automatically on backend start (idempotent).
- Health: `curl -s http://localhost:8080/api/health` → `{"status":"ok","db":"up","env":"testing"}`
- Browser needs **Ctrl+Shift+R** after a frontend deploy (cached old bundle).

If port 80 is taken by another service, remove the `"80:80"` line in
`compose.test.yaml` — `:8080` keeps everything working.

## 6. Deploy — Production (VM on 110, project `ams-prod`)

```bash
cd /opt/admin
bash scripts/server/deploy-prod.sh          # build + up + health check
REBUILD=0 bash scripts/server/deploy-prod.sh # up without rebuild
# equivalent manual command:
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod up -d --build
```

- Health: `curl -s http://127.0.0.1:3010/api/health` → `{"status":"ok","env":"production","db":"up"}`
- UI: `http://192.168.100.110:3080`
- First boot seeds the prod DB (sysadmin/admin1/head1/… with `SEED_PASSWORD` from `.env.prod`).
- Prod DB is empty/separate from testing — set up departments/users once.
- ⚠️ VM has 2 CPU / 3.8 GB RAM running both stacks — watch memory; if tight,
  stop testing: `docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test down`.

## 7. Ports cheat-sheet (current VM)

| Port | Bound | What |
|---|---|---|
| 80 | `0.0.0.0` (testing frontend) | UI — plain `http://192.168.100.110` |
| 8080 | `0.0.0.0` (testing frontend) | UI (legacy bookmark) |
| 3000 | `127.0.0.1` (testing backend) | API — internal only (nginx proxies `/api/`) |
| 3080 | `0.0.0.0` (prod frontend) | Prod UI |
| 3010 | `127.0.0.1` (prod backend) | Prod API — internal only |
| 5432 | docker networks only | postgres (never published) |

## 8. Future physical server — ready-to-deploy playbook

The codebase is deployment-agnostic. When the physical server is ready:

### 8.1 One-command provisioning

From the Windows dev machine (Git Bash):
```bash
NEW_HOST=<new-server-ip> NEW_USER=glgadmin PW='<initial password>' \
  bash scripts/server/provision-new-server.sh
# add PROVISION_DEPLOY=1 to also build & start the stack immediately
# add SETUP_ENV=prod for the production stack (UI :3080) instead of testing
```
The script: installs Docker + Compose, installs the SSH key, checks out
`/opt/admin` from GitHub, creates `.env.<env>` from the template, and
(optionally) builds + starts + health-checks.

### 8.2 Manual steps (what the script automates)

1. Ubuntu 22.04 + sudo user, SSH reachable.
2. Docker: `bash scripts/server/bootstrap-server.sh` (PW via env var).
3. Key: append dev machine's `~/.ssh/id_ed25519.pub` to the server's
   `~/.glgadmin/authorized_keys` (i.e. `~/.ssh/authorized_keys`).
4. Checkout:
   ```bash
   sudo mkdir -p /opt/admin && sudo chown $USER /opt/admin
   cd /opt/admin
   git init -b main && git remote add origin https://github.com/salaithantzawwin1/admin.git
   git fetch origin main && git checkout -f main
   git config --global --add safe.directory /opt/admin
   ```
5. Secrets: `cp env/.env.prod.example .env.prod && nano .env.prod`
   — **use fresh, different POSTGRES_PASSWORD / JWT_SECRET / SEED_PASSWORD than 110!**
6. Start (prod): `docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod up -d --build`
   → UI on `:3080`, backend on loopback `:3010`.
7. Verify: `curl http://localhost:3010/api/health` and open `http://<ip>:3080`.

### 8.3 Migrating real data from the VM (when going live)

```bash
# on 110 — dump prod data
docker exec ams-prod-db-1 pg_dump -U ams ams > ams-prod-$(date +%F).sql
docker run --rm -v ams-prod_uploads_data:/data -v $PWD:/backup alpine \
  tar czf /backup/uploads-$(date +%F).tgz -C /data .

# on the new server — restore
docker exec -i ams-prod-db-1 psql -U ams ams < ams-prod-<date>.sql
docker run --rm -v ams-prod_uploads_data:/data -v $PWD:/backup alpine \
  tar xzf /backup/uploads-<date>.tgz -C /data
```
(Compose file references `POSTGRES_DB`/`POSTGRES_USER` — adjust `-U ams ams` if
your `.env.prod` differs. Keep the dumps OFF git.)

### 8.4 Cutover checklist

- [ ] New server provisioned (§8.1/§8.2), health OK
- [ ] Fresh secrets set (not reused from 110)
- [ ] Data migrated (§8.3) + spot-check: users, requests, inventory balances
- [ ] DNS/hosts/clients pointed at the new IP
- [ ] Backups scheduled on the new server
- [ ] On 110: keep dev+testing; retire the VM prod stack
  (`docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod down`)

## 9. Health & logs

```bash
cd /opt/admin
# testing
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test ps
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test logs -f backend
curl -s http://127.0.0.1:3000/api/health && curl -s http://127.0.0.1:3000/api/docs  # Swagger (server-local)
# prod
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod ps
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod logs -f backend
curl -s http://127.0.0.1:3010/api/health
```

## 10. Seeded users (Phase 1, password = SEED_PASSWORD)

| Username | Role |
|---|---|
| sysadmin | SYSTEM_ADMIN |
| admin1 | ADMINISTRATION |
| head1 | DEPARTMENT_HEAD |
| manager1 | MANAGEMENT |
| employee1 | EMPLOYEE |

## 11. Troubleshooting notes

- **Prisma on alpine:** OpenSSL detection is broken here and picks 1.1 engines → runtime
  crash. Fix: backend uses `node:20-bookworm` (Debian, OpenSSL 3). Do not switch to alpine.
- **Server network:** only HTTPS to npm/Docker Hub allowed; `deb.debian.org`,
  `dl-cdn.alpinelinux.org`, plain HTTP:80 blocked → avoid apt at build time.
- **git on SMB:** "dubious ownership" → `git config --global --add safe.directory /opt/admin`
  (server) or the `%(prefix)///192.168.100.110/admin/` form (Windows Git Bash).
- **Seed/migrate** run automatically on every backend container start (idempotent).
- **Hard refresh** the browser after frontend deploys.

## 12. Recent decisions log

- 2026-09-23 — repo initialized on the Samba share, pushed to GitHub; `.env.*` gitignored.
- 2026-09-23 — prod deploy fixes: pre-flight typecheck skips when host has no node/tsc;
  backend loopback remapped to avoid the frontend :3000 clash.
- 2026-09-23 — testing frontend now also binds port 80 (plain URL, no port in browser).
- 2026-09-23 — inventory hardening: atomic item codes (`NumberingService.nextStable`),
  transactional fulfill (fresh stock reads) / reject (closes doc too), item images JWT-protected
  via `?token=` (`<img>` tags pass the token as a query param), single `ScheduleModule.forRoot()`
  in AppModule.
- 2026-09-23 — **single-server topology**: there is no second (101) server — 110 runs
  testing (`ams`: :80/:8080) and production (`ams-prod`: :3080) side by side; removed the
  old rsync-to-101 deploy script.
- 2026-09-23 — removed a hardcoded server password from `bootstrap-server.sh` (pass `PW=` env);
  added `provision-new-server.sh` for the future physical server; documented the
  ready-to-deploy playbook (§8).
