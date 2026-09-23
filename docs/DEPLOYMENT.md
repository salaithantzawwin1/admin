# AMS — Development & Deployment Guide (Phase 1)

Server: **adminsrv** — Ubuntu 22.04, 192.168.100.110 (user `glgadmin`, in `docker` group)
Project root on server: **/opt/admin** (lowercase; Samba share = Windows drive `Y:` = `\\\\192.168.100.110\\\\admin`)

> Note: the Windows working copy and the server directory are the same files (Samba),
> so edits made from Windows appear on the server immediately. Only build/run on the server
> (npm/node must run inside Docker or on Linux — Windows cannot run npm from a UNC path).

## Deploy after changes (one step)

Whenever a change needs deploying, do it in one go (Testing stack) — no separate copy step:

```bash
# from the server (or via plink ssh glgadmin@192.168.100.110)
cd /opt/admin
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test up -d --build
```

- Rebuilds both images, recreates containers, auto-runs `prisma migrate deploy` + seed.
- Verify: `curl -s http://192.168.100.110:8080/api/health` → `{status: ok, db: up}`.
- Browser must hard-refresh (Ctrl+Shift+R) after a frontend deploy (cached old bundle).

## Layout (Plan v3.0 §24)

```
/opt/Admin/
├── compose.yaml            # base
├── compose.test.yaml       # testing override
├── compose.prod.yaml       # production override
├── env/                    # env templates (real .env.* never committed)
├── backend/                # NestJS + Prisma API
├── frontend/               # React + Vite + Tailwind (served by nginx)
├── scripts/                # server + deployment scripts
└── docs/                   # plans & guides
```

## First-time server bootstrap (done 2026-09-17)

Docker Engine 29.8.1 + Compose v5.5.1 installed via `scripts/server/bootstrap-server.sh`.
`glgadmin` is in the `docker` group (applies on next login).

## Run Testing stack

```bash
cd /opt/Admin
cp env/.env.test.example .env.test   # then edit secrets
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test up -d --build
```

- Frontend: http://192.168.100.110:8080
- API (loopback only): http://127.0.0.1:3000/api
- API docs (Swagger): http://127.0.0.1:3000/api/docs

## Status (2026-09-17)

Phase 1 + Phase 2 deployed and verified on Testing stack:
- Health check public: `GET /api/health` → `{status: ok, db: up, env: testing}`
- Login + JWT, `/auth/me`, change-password working
- Global JWT guard + `@Public()` decorator; server-side RBAC verified (employee1 → /users = 403)
- Audit trail recording LOGIN_SUCCESS/FAILED with IP (append-only)
- Users / Departments / Employees / Audit Logs pages live at http://192.168.100.110:8080

**Phase 2 — Workflow Engine (verified end-to-end):**
- Reusable approval workflow (configurable steps per module): GENERIC_REQUEST = DEPARTMENT_HEAD (L1) → MANAGEMENT (L2)
- Request lifecycle DRAFT → PENDING_APPROVAL → APPROVED (+REJECTED/RETURN/CANCELLED)
- Document numbering: `GEN-2026-0001` style, atomic per prefix+year
- Approvals inbox per role, approval history immutable
- Delegations (date-ranged, audited) — delegate approves on behalf of, verified
- Auto-escalation cron (hourly; `ESCALATION_AFTER_HOURS` env, default 72h) for stale L1 requests
- Notifications: bell UI, unread count, SUBMITTED/APPROVED/REJECTED/RETURNED/FINAL_APPROVED/DELEGATED/ESCALATED
- Attachments: upload (10 MB, whitelist), download, delete; stored in `uploads_data` volume
- Swagger: http://127.0.0.1:3000/api/docs

**Phase 3 — Car Request Module (verified end-to-end):**
- Fleet master: vehicles (type/brand/capacity/mileage/status) + drivers, Administration-guarded CRUD
- Car Request: `CAR-2026-0001` numbering, destination/schedule/passengers/vehicle-type-required
- Approval via reusable engine (L1 Head → L2 Management), then Administration assigns vehicle + driver
- **Double-booking prevention**: transaction + overlap re-check → 409 Conflict on overlapping window (verified)
- Trips: start odometer → complete odometer (validates monotonic, updates vehicle mileage — verified 45200→45340)
- Expenses: FUEL/TOLL/PARKING/REPAIR/OTHER per trip
- Vehicle status flow: AVAILABLE → IN_USE (assigned) → AVAILABLE (trip completed)
- UI: Fleet page, Car Requests page, CarPanel on request detail (assign / trip / expenses)

**RBAC Permission Matrix (verified end-to-end):**
- DB-backed permissions (`permissions` + `role_permissions` tables) — 14-code catalog synced on every backend boot
- Global PermissionsGuard (runs after JWT + Roles guards) — denied requests → 403
- Login/`/auth/me` return effective permissions; frontend sidebar filters by permission
- Permission Matrix UI at `/rbac` (users.manage required): role × permission checkbox grid, SYSTEM_ADMIN locked as superuser
- Every matrix change audit-logged as `ROLE_PERMISSIONS_UPDATED`
- Verified: employee1→/users 403, admin1→/users 403 (no users.read), head1→fleet write 403, matrix edit 403 for non-admin, grant/revert live without redeploy

**Master Data Full CRUD (verified end-to-end):**
- Users: create, edit (name/email/roles), reset password (verified login with new password), enable/disable (self-protect), delete (blocked with 409 if user has request/approval history)
- Branches: create, edit (name/address/phone), deactivate/activate, delete — 409 if departments/employees attached
- Departments: create, edit, deactivate/activate, delete — 409 if employees/requests attached
- Employees: create, edit (position/phone/email/department), activate/deactivate, delete — 409 if heads a department or has linked requests
- All writes audit-logged; UI modals with type-to-confirm for destructive actions

## Seeded users (Phase 1, password = SEED_PASSWORD)

| Username | Role |
|---|---|
| sysadmin | SYSTEM_ADMIN |
| admin1 | ADMINISTRATION |
| head1 | DEPARTMENT_HEAD |
| manager1 | MANAGEMENT |
| employee1 | EMPLOYEE |

## Health & logs

```bash
cd /opt/admin
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test ps
docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test logs -f backend
curl -s http://127.0.0.1:3000/api/health
```

## Troubleshooting notes (this server)

- **Prisma on alpine:** OpenSSL detection is broken here and picks 1.1 engines → runtime crash.
  Fix: backend uses `node:20-bookworm` (Debian, OpenSSL 3 preinstalled). Do not switch backend to alpine.
- **Server network:** only HTTPS to npm/Docker Hub allowed; `deb.debian.org`, `dl-cdn.alpinelinux.org`,
  plain HTTP:80 are blocked → avoid base images that need `apt-get install` at build time.
- **Seed/migrate** run automatically on every backend container start (idempotent).
