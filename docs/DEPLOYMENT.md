# AMS — Development & Deployment Guide

> Last updated: 2026-09-23 (after git-based workflow migration)
> Verified on: adminsrv (192.168.100.110, Ubuntu 22.04.5 LTS, Docker 29.8.1, Compose v5.5.1)

## 1. Servers & topology

| | Testing | Production |
|---|---|---|
| IP | `192.168.100.110` (adminsrv) | `192.168.100.101` |
| User | `glgadmin` | `glgadmin` |
| SSH | ✅ key-based (see §3) — `ssh glgadmin@192.168.100.110` | password / interactive |
| Project root | `/opt/admin` | `/opt/admin` (created by deploy script) |
| UI URL | `http://192.168.100.110` (port 80) **and** `:8080` | `http://192.168.100.101:3000` |
| API | loopback-only `127.0.0.1:3000` (never exposed) | loopback-only `127.0.0.1:3010` |
| Compose files | `compose.yaml` + `compose.test.yaml` + `.env.test` | `compose.yaml` + `compose.prod.yaml` + `.env.prod` |

**Production server network restriction:** only HTTPS to npm/Docker Hub allowed;
`deb.debian.org`, alpine CDN, plain HTTP:80 are blocked → backend image must stay
on `node:20-bookworm` (do NOT switch to alpine).

## 2. Samba share = the same files

`\\192.168.100.110\admin` (Windows drive **Y:**) **is** `/opt/admin` on the server —
one copy of the files. Editing from Windows edits the server copy instantly.

Consequences:
- **No copy step needed** for testing deploys. Build/run must happen on the server
  (node/npm only run inside Docker there — the host has no node).
- The **git repo lives on the share too** (`.git` inside Y:). One caveat: git
  index writes over SMB can occasionally misbehave — if `git status` ever looks
  wrong, run `git status` again / `git fsck` from Git Bash, or from a server SSH shell.

## 3. SSH access (set up 2026-09-23)

- Key auth is installed for `glgadmin@192.168.100.110` (ed25519 `codebuff@ams-dev`,
  Windows dev machine). From Git Bash: `ssh glgadmin@192.168.100.110` — no password.
- PuTTY `plink` is available on the Windows machine as a fallback.
- Recommended hardening: switch the server to key-only auth (`sshd_config`:
  `PasswordAuthentication no`) and change the shared password.

## 4. Git workflow

- Remote: `https://github.com/salaithantzawwin1/admin.git` (branch `main`)
- Identity (repo-local): `salaithantzawwin1` / `salaithantzawwin1@users.noreply.github.com`
- **Secrets are never committed**: `.env.test`, `.env.prod`, `.env` are gitignored;
  only `*.example` templates are in the repo.

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

## 5. Deploy — Testing (192.168.100.110)

```bash
# from the server (or ssh glgadmin@192.168.100.110)
cd /opt/admin
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test up -d --build
```

- `--build` needed when code changed; plain `up -d` is enough for port/env-only changes.
- Migrations + seed run automatically on backend start (idempotent).
- Health check:
  ```bash
  curl -s http://localhost:8080/api/health   # → {"status":"ok","db":"up","env":"testing"}
  ```
- Browser needs **Ctrl+Shift+R** after a frontend deploy (cached old bundle).

Port layout (testing):
| Port | Bound to | Notes |
|---|---|---|
| 80 | frontend | plain `http://192.168.100.110` (added 2026-09-23, `0c9540c`) |
| 8080 | frontend | original UI port, kept for old bookmarks |
| 3000 | backend | `127.0.0.1` only — browsers never need it (nginx proxies `/api/`) |

If port 80 is taken by another service, remove the `"80:80"` line in
`compose.test.yaml` — `:8080` keeps everything working.

## 6. Deploy — Production (192.168.100.101)

Prod is a **different server** (no Samba) — sync from the Windows machine:

```bash
# Windows Git Bash, from the repo root (Y:)
bash scripts/server/deploy-prod.sh
#   → typecheck (skipped when node/tsc missing on the host)
#   → rsync over SSH (excludes node_modules, dist, .env.*)
#   → docker compose up -d --build with .env.prod
#   → health check
```

`SKIP_SYNC=1 bash scripts/server/deploy-prod.sh` — rebuild only (sources already on server).

`.env.prod` must already exist on the prod server (created manually from
`env/.env.prod.example`; never synced, never committed).

Port layout (prod): frontend `0.0.0.0:3000`, backend loopback `127.0.0.1:3010`
(remapped via `!override` in `compose.prod.yaml` to avoid the :3000 clash).

## 7. Ports cheat-sheet (both stacks)

| Port | Where | What |
|---|---|---|
| 80 | testing host | UI (default http://192.168.100.110) |
| 8080 | testing host | UI (legacy) |
| 3000 | testing host loopback | backend API (internal, nginx proxies /api/) |
| 3010 | prod host loopback | backend API (internal) |
| 3000 | prod host | prod UI (frontend nginx) |
| 5432 | docker network only | postgres (never published) |

## 8. Health & logs

```bash
cd /opt/admin
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test ps
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test logs -f backend
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:3000/api/docs      # Swagger (server-local)
```

## 9. Seeded users (Phase 1, password = SEED_PASSWORD)

| Username | Role |
|---|---|
| sysadmin | SYSTEM_ADMIN |
| admin1 | ADMINISTRATION |
| head1 | DEPARTMENT_HEAD |
| manager1 | MANAGEMENT |
| employee1 | EMPLOYEE |

## 10. Troubleshooting notes (this server)

- **Prisma on alpine:** OpenSSL detection is broken here and picks 1.1 engines → runtime
  crash. Fix: backend uses `node:20-bookworm` (Debian, OpenSSL 3). Do not switch to alpine.
- **Server network:** only HTTPS to npm/Docker Hub allowed; `deb.debian.org`,
  `dl-cdn.alpinelinux.org`, plain HTTP:80 blocked → avoid apt at build time.
- **git on SMB:** "dubious ownership" → `git config --global --add safe.directory /opt/admin`
  (server) or the `%(prefix)///192.168.100.110/admin/` form (Windows Git Bash).
- **Seed/migrate** run automatically on every backend container start (idempotent).
- **Hard refresh** the browser after frontend deploys.

## 11. Recent decisions log

- 2026-09-23 — repo initialized on the Samba share, pushed to GitHub; `.env.*` gitignored.
- 2026-09-23 — prod deploy fixes: pre-flight typecheck skips when host has no node/tsc;
  prod backend loopback port 3000→3010 (`!override`) to free :3000 for the prod frontend.
- 2026-09-23 — testing frontend now also binds port 80 (plain URL, no port in browser).
- 2026-09-23 — inventory hardening: atomic item codes (`NumberingService.nextStable`),
  transactional fulfill (fresh stock reads) / reject (closes doc too), item images JWT-protected
  via `?token=` (`<img>` tags pass the token as a query param), single `ScheduleModule.forRoot()`
  in AppModule.
