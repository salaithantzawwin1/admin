# AMS — Development & Deployment Guide

> Last updated: **2026-09-25 — ENVIRONMENT REDESIGNATION (see §1b)**
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

## 1b. ⭐ ENVIRONMENT DESIGNATION — which URL is which (READ THIS FIRST)

> **Effective 2026-09-25 (user decision) — this reverses the old policy.**
> Both stacks run side by side on 110 from the same checkout:
>
> | | URL | Compose project | Env label in header | Data |
> |---|---|---|---|---|
> | **PRODUCTION** | **`http://192.168.100.110/` (port 80, no port in URL)** | `ams` (`compose.prod.yaml` + `.env.prod`) | **Production** | **REAL data** — `ams_db_data`, `ams_uploads_data` |
> | **TESTING** | **`http://192.168.100.110:8030`** | `ams-test` (`compose.test.yaml` + `.env.test`) | **Testing** | disposable/reseedable — `ams-test_db_data`, `ams-test_uploads_data` |
>
> - **Users work in `http://192.168.100.110/` — that is PRODUCTION now.** Treat its
>   data as live: no destructive experiments, cleanup scripts must target `:8030`.
> - Testing (`:8030`) is where new code is verified first; deploy to `:80` after.
> - The header badge in the UI shows which environment you are on
>   (`Production` on :80, `Testing` on :8030 — injected via `VITE_ENV_LABEL`).
> - **Old `ams-prod` project (`:3080`/`:3010`) is retired** — its data volumes
>   (`ams-prod_db_data`) were empty; the real production data always lived in
>   `ams_db_data`, which the new `:80` production stack reuses. Nothing was lost.
> - Old `:8080` and `:3080`/`:3010` mappings are gone — update bookmarks.

### Current stacks on 192.168.100.110

| Stack | Project | Compose files | UI | Backend (loopback) | Data volumes | Status |
|---|---|---|---|---|---|---|
| **Production** | `ams` | `compose.yaml` + `compose.prod.yaml` + `.env.prod` | **`:80`** | `127.0.0.1:3000` | `ams_db_data`, `ams_uploads_data` (real data) | **RUNNING** |
| **Testing** | `ams-test` | `compose.yaml` + `compose.test.yaml` + `.env.test` | **`:8030`** | `127.0.0.1:3011` | `ams-test_db_data`, `ams-test_uploads_data` | **RUNNING** |
| (retired) | `ams-prod` | — | ~~`:3080`~~ | ~~`:3010`~~ | `ams-prod_*` (empty) | stopped — volumes kept for now, safe to delete |

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

## 3b. RBAC checklist — when adding a NEW module (mandatory)

Every new backend module MUST be RBAC-gated; every new capability MUST appear in
the Permission Matrix (`/rbac`). Do not hard-code role names — add permission codes.

1. **Add code(s) to the catalog** — `backend/src/auth/permissions.ts`:
   `<module>.read` (view) and `<module>.manage` (administer) are the conventions
   (e.g. `employees.read`, `employees.manage`, `departments.manage`, `fleet.types.manage`).
2. **Enforce on endpoints** — in the module's controller:
   `@RequirePermissions(PERMISSIONS.MODULE_MANAGE)` for writes; for list endpoints
   use `@AnyPermission([ORG_READ], [MODULE_READ])`-style OR-gates so either the
   full org view or the module-specific read grants access. Service-level checks
   use `PermissionsService.userHas(userId, code)`.
3. **Notification broadcasts** — never query `role: { name: 'ADMINISTRATION' }`.
   Use `permissions.usersWithPermissions(['<module>.manage'])` (ACTIVE users only).
4. **Default grants** — add the code to `DEFAULT_GRANTS` in
   `backend/src/auth/permissions-seed.ts` for the roles that should have it
   (boot seed only fills codes a role never had — matrix edits survive).
5. **Frontend** — sidebar entry in `Layout.tsx` with
   `hasPermission('<module>.read')`; hide action buttons with
   `hasPermission('<module>.manage')`; add friendly labels + group in
   `frontend/src/pages/RbacMatrix.tsx` (PERM_LABELS + GROUPS).
6. **Verify** — matrix shows the new code sorted A→Z; 403 without grant,
   200/201 with; E2E script under `scripts/server/verify-rbac.sh` conventions.

Existing RBAC-native examples: departments (read/manage), employees (read/manage),
announcement album/ack flows, fleet types, meeting-room facilities.

### UI conventions (mandatory — kept this way app-wide)

- **No native browser popups.** `window.confirm`, `window.alert`, `window.prompt`
  are banned — they render as "192.168.100.110 says …" native dialogs that cannot
  be styled and break the app's look. Use the in-app components instead:
  - `<ConfirmDialog>` (`frontend/src/components/ConfirmDialog.tsx`) — confirm a
    destructive action; supports `variant="danger"`, a `withNote` textarea
    (replaces window.prompt), and it **stays open on error** showing the failure
    inside (rethrow from `onConfirm`).
  - `toast('Saved')` (`frontend/src/components/Toast.tsx`) — success/info/error
    feedback after actions.
- **Permission Matrix sorting** — the backend serves the catalog A→Z
  (`/auth/permissions/matrix` returns `[...ALL_PERMISSION_CODES].sort()`), and the
  matrix page sorts rows within each group again. If a new permission appears
  unsorted in the UI, hard-refresh (Ctrl+Shift+R) first — stale JS bundles
  predate the sort; nginx now sends `index.html` with no-cache so future deploys
  update automatically.
- A build that fails these conventions should not ship — grep for
  `window.confirm|window.prompt|window.alert` in `frontend/src` before committing
  UI work; only comments may match.
- **Tabs and sub-tabs live in the URL as query params (mandatory).** Any page
  with tabs — and any nested sub-tab set — must keep its state in the URL so
  refresh, back/forward, bookmarks, and shared links land on the exact view:
  - top-level tab: `?tab=<key>` (e.g. `/inventory?tab=management`, `/inventory?tab=purchases`,
    `/meeting-rooms?tab=setup`)
  - second-level sub-tab: add `&sub=<key>` (e.g. Inventory Management:
    `/inventory?tab=management&sub=queue` · `&sub=restock` · `&sub=alerts` ·
    `&sub=reorder` · `&sub=items`)
  - the default tab/sub-tab stays parameterless (`/inventory` = catalog,
    `?tab=management` = To-issue queue)
  - switching tabs uses `setSearchParams(..., { replace: false })` so browser
    Back walks the tab history
  - when adding a new tabbed page, follow the existing pattern
    (`useSearchParams` → read param → validate against the known keys →
    fallback to default); do NOT keep tab state in bare `useState`

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

## 5. Deploy — Testing (`:8030`, project `ams-test`)

```bash
cd /opt/admin
bash scripts/server/deploy-testing.sh        # pull + rebuild + health + bundle-freshness check
# NO_PULL=1 bash scripts/server/deploy-testing.sh   # deploy local edits without pulling
```

- `--build` needed when code changed; plain `up -d` suffices for port/env-only changes.
- Migrations + seed run automatically on backend start (idempotent).
- Health: `curl -s http://127.0.0.1:3011/api/health` → `{"status":"ok","db":"up","env":"testing"}`
- UI: **`http://192.168.100.110:8030`** — header badge shows **Testing**.
- Browser needs **Ctrl+Shift+R** after a frontend deploy (cached old bundle).
- Testing containers: `ams-test-backend-1`, `ams-test-db-1`, `ams-test-frontend-1`
  (server scripts under `scripts/server/` target these for testing operations).

## 6. Deploy — Production (`:80`, project `ams`)

```bash
cd /opt/admin
bash scripts/server/deploy-prod.sh           # pull + build + up + health check
REBUILD=0 bash scripts/server/deploy-prod.sh # up without rebuild
# equivalent manual command:
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod up -d --build
```

- Health: `curl -s http://127.0.0.1:3000/api/health` → `{"status":"ok","env":"production","db":"up"}`
- UI: **`http://192.168.100.110/`** (plain port 80) — header badge shows **Production**.
- **This is the live-data stack** — migrations run automatically on boot; matrix
  edits here are the authoritative RBAC state (deny-memory protects them).
- Production containers: `ams-backend-1`, `ams-db-1`, `ams-frontend-1`.
- Deploy order: verify on testing (`:8030`) first, then deploy prod (`:80`).

## 7. Ports cheat-sheet (current VM)

| Port | Bound | What |
|---|---|---|
| 80 | `0.0.0.0` (ams frontend) | **PRODUCTION UI** — `http://192.168.100.110/` (header badge: Production) |
| 3000 | `127.0.0.1` (ams backend) | Production API — internal only (nginx proxies `/api/`) |
| 8030 | `0.0.0.0` (ams-test frontend) | **TESTING UI** — `http://192.168.100.110:8030` (header badge: Testing) |
| 3011 | `127.0.0.1` (ams-test backend) | Testing API — internal only |
| ~~3080 / 3010~~ | — | retired (old ams-prod stack) |
| 5432 | docker networks only | postgres (never published) |

## 8. Future physical server — ready-to-deploy playbook

The codebase is deployment-agnostic. When the physical server is ready:

### 8.1 One-command provisioning

From the Windows dev machine (Git Bash):
```bash
NEW_HOST=<new-server-ip> NEW_USER=glgadmin PW='<initial password>' \
  bash scripts/server/provision-new-server.sh
# add PROVISION_DEPLOY=1 to also build & start the stack immediately
# add SETUP_ENV=prod for the production stack (UI :80) instead of testing (:8030)
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
# on 110 — dump PRODUCTION data (project ams, UI :80)
docker exec ams-db-1 pg_dump -U ams ams > ams-prod-$(date +%F).sql
docker run --rm -v ams_uploads_data:/data -v $PWD:/backup alpine \
  tar czf /backup/uploads-$(date +%F).tgz -C /data .

# on the new server — restore
docker exec -i ams-db-1 psql -U ams ams < ams-prod-<date>.sql
docker run --rm -v ams_uploads_data:/data -v $PWD:/backup alpine \
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
- [ ] On 110: keep testing (`:8030`); stop the VM production stack
  (`docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod down`)

## 9. Health & logs

```bash
cd /opt/admin
# TESTING (project ams-test — UI :8030)
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test ps
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test logs -f backend
curl -s http://127.0.0.1:3011/api/health && curl -s http://127.0.0.1:3011/api/docs  # Swagger (server-local)
# PRODUCTION (project ams — UI :80)
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod ps
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env.prod logs -f backend
curl -s http://127.0.0.1:3000/api/health
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

- **Backend `P1000 Authentication failed` after changing `POSTGRES_PASSWORD`:**
  `POSTGRES_PASSWORD` only applies when the data volume is FIRST initialized — on an
  existing volume the `ams` role keeps its original password, so a changed env file
  breaks the backend's `DATABASE_URL` (crash loop). Fix with the one-shot script:
  `bash scripts/server/fix-db-password.sh ams-db-1` (or `ams-test-db-1`), which
  runs `ALTER USER ams WITH PASSWORD '<env value>'` over the container's local
  socket. (Hit for real on 2026-09-25 during the :80/:8030 swap.)
- **Prisma on alpine:** OpenSSL detection is broken here and picks 1.1 engines → runtime
  crash. Fix: backend uses `node:20-bookworm` (Debian, OpenSSL 3). Do not switch to alpine.
- **Server network:** only HTTPS to npm/Docker Hub allowed; `deb.debian.org`,
  `dl-cdn.alpinelinux.org`, plain HTTP:80 blocked → avoid apt at build time.
- **git on SMB:** "dubious ownership" → `git config --global --add safe.directory /opt/admin`
  (server) or the `%(prefix)///192.168.100.110/admin/` form (Windows Git Bash).
- **Seed/migrate** run automatically on every backend container start (idempotent).
- **Hard refresh** the browser after frontend deploys.

## 12. Recent decisions log

- 2026-09-25 — **ENVIRONMENT REDESIGNATION (user decision)**: PRODUCTION is now
  the plain `http://192.168.100.110/` (`:80`, project `ams`, real data in
  `ams_db_data`); TESTING moved to `http://192.168.100.110:8030` (new project
  `ams-test`, backend loopback `:3011`). The old `ams-prod` project (`:3080`)
  is retired — its DB was empty; the real data always lived in `ams_db_data`,
  which the `:80` production stack reuses. The UI header now shows a
  Production/Testing badge injected at build time (`VITE_ENV_LABEL`). All
  server scripts updated: testing scripts target `ams-test-*` containers and
  `:3011`; production/probe scripts target `ams-db-1`/`ams-backend-1` and `:3000`.
  Deploy testing first, then production.
- 2026-09-25 — RBAC hardening landed on both stacks: deny-memory
  (`role_permissions_denied`, migration 34) so matrix revocations survive
  restarts; `/org/employees` + `/org/departments` gated by dedicated
  `employees.read`/`departments.read` (migration 35); suppliers reads gated by
  `suppliers.read` only; unit tests in `backend/test/rbac-deny-memory.test.ts` (21 cases).

- 2026-09-24 — **added `scripts/server/deploy-testing.sh`** after the CarPanel React #310
  crash survived a manual deploy: a stale checkout (no `git pull`) silently re-deploys old
  bugs. The script pulls, rebuilds, health-checks and warns when a frontend change did NOT
  change the served bundle hash; `deploy-prod.sh` got the same pull-first pre-flight.
- 2026-09-24 — **removed the testing frontend's legacy `:8080` mapping** — `http://192.168.100.110/`
  is the one and only testing URL; verify scripts, Telegram webUrl default and docs
  updated to `:80`.
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
- 2026-09-23 — announcements MVP live (migration 24/25): create/schedule/publish, targeting,
  read/ack tracking, notifications.
- 2026-09-23 — attachments generalized: `attachments.announcementId` (migration 26),
  ownership-checked upload, cleanup on announcement delete; announcements E2E verify
  script (`verify-announcements.sh`, 17 steps).
- 2026-09-23 — **RBAC aligned with plan §5b**: `announcements.read` granted to all roles
  including PURCHASING/FINANCE (migration 27 + boot seed); Permission Matrix screen now
  labels all 19 codes; added `verify-rbac.sh` (guard 403/200 checks, runtime matrix edit,
  superuser lock, audit logging).
- 2026-09-23 — announcements v2: **Unpublish** (PUBLISHED → DRAFT, read/ack history kept,
  audit-logged), rich-text compose (sanitized HTML: bold/italic/underline/strike, H2/H3,
  lists, alignment — script/style/event handlers stripped server-side), notification and
  Telegram bodies now plain text, photo-first attachments (image grid + zoom, docs as
  download cards), 10-file per-announcement cap, admin detail view.
