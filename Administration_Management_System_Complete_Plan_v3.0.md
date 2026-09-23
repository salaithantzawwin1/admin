# ADMINISTRATION MANAGEMENT SYSTEM

**Complete Development, Workflow & Deployment Plan**

**Version 3.0** | Testing → UAT → Production Migration

> **v3.0 Changes:** Adds a dedicated **Maintenance Management** module (Maintenance Request, Maintenance Record, Preventive Maintenance & Scheduling, Service Providers, Parts & Cost, Maintenance Reports), links maintenance history to Fixed Assets and Vehicles, and applies the v2.0 review fixes (missing entities, Finance invoice/payment, branch/location master, document numbering, backup retention, CI/CD, monitoring, locale, append-only audit log, seed data, security-from-Phase-1).

---

## 1. Project Objective

Build a production-ready internal Administration Management System (AMS) that digitizes administration requests, approvals, purchasing, receiving, fixed assets, inventory, vehicles, meeting rooms, **complete maintenance management (corrective + preventive)**, announcements, notifications, reporting and audit tracking.

The system must be modular, secure, maintainable and designed so that development and UAT can be performed on a Testing Server first, then migrated to a separate Real Production Server using a controlled, repeatable deployment and rollback process.

**Key principle:** every asset and vehicle must have a complete, immutable maintenance history — so that opening any Aircon, Generator, UPS, Office Equipment or Car shows its full service life: problems, work performed, parts, vendor, cost, warranty and next due service.

---

## 2. Recommended Technology

| Layer | Recommendation |
|---|---|
| Operating System | Ubuntu Server 24.04 LTS |
| Containerization | Docker + Docker Compose |
| Reverse Proxy | Nginx |
| Frontend | React + Vite |
| UI | Tailwind CSS |
| Backend | NestJS / REST API |
| Database | PostgreSQL |
| ORM | Prisma |
| Source Control | Git + GitHub/Git repository |
| CI/CD | GitHub Actions → build/test → push image → deploy release artifact *(added in v3.0)* |
| File Storage | Persistent filesystem volume; optional MinIO later |
| Authentication | Application authentication + RBAC; LDAP/AD-ready |
| Monitoring | Uptime-Kuma (uptime) + log persistence + disk-space alerts *(added in v3.0)* |
| API Docs | Swagger/OpenAPI auto-generated from NestJS *(added in v3.0)* |
| Backup | PostgreSQL backup + uploads/configuration backup, with defined retention |
| Locale | Timezone `Asia/Yangon`; date format `YYYY-MM-DD`; currency MMK (multi-currency field ready); Myanmar/English UI labels *(added in v3.0)* |

---

## 3. Main Modules

- Dashboard
- Authentication / Users / Roles / Permissions
- Departments / Employees / **Branches & Locations**
- Approval Workflow
- Administration Announcement
- Car Request
- Meeting Room Request
- Purchase Request
- Purchasing / Vendor / Quotation / PO / **Invoice & Payment**
- Goods Received Note (GRN)
- Inventory / Store
- Fixed Asset Management
- **Maintenance Management**
  - Maintenance Request (corrective / ad-hoc)
  - Maintenance Record (corrective + preventive service records)
  - Preventive Maintenance (schedules, due / upcoming / overdue)
  - Service Providers / Vendors
  - Parts & Cost
  - Maintenance Reports
- Maintenance / Repair Request
- Office Supply Request
- Travel Request
- Visitor Management
- Event / Catering
- Notifications
- Attachments
- Audit Logs
- Reports & Analytics

---

## 4. User Roles

| Role | Main Responsibility |
|---|---|
| Employee | Create and view own requests; read announcements. |
| Department Head | Review and approve/reject department requests. |
| Administration | Process admin requests, vehicles, rooms, GRN, assets, maintenance and announcements. |
| **Maintenance Coordinator** *(new)* | Maintain maintenance records, manage preventive schedules, assign technicians/service providers, close work orders. |
| Technician / Service Provider (portal user, optional) | View assigned maintenance tasks and update work progress. *(optional future phase)* |
| Purchasing | Handle quotations, vendor selection, PO and purchasing process. |
| Finance | View purchase, invoice, payment information as permitted (backed by Invoice/Payment entities — see §9). |
| Management | Approve high-value/controlled requests and view management reports. |
| System Administrator | Users, roles, permissions, workflow, master data and technical settings. |

**RBAC Permission Matrix *(NEW in v3.0)*:** every role maps to fine-grained **permissions** (e.g. `users.read`, `users.manage`, `org.manage`, `requests.create`, `approvals.act`, `fleet.manage`, `cars.assign`, `audit.read`, `attachments.use`). Permissions are stored in the database (`permissions` + `role_permissions` tables), enforced by a global backend guard, used to filter the UI menu, and editable at runtime by System Admin via a Permission Matrix screen. `SYSTEM_ADMIN` is the superuser and always has full access. Every matrix change is audit-logged. See §5b.

---

## 5. Common Workflow Engine

Use one reusable workflow/approval engine across request modules.

```
DRAFT → SUBMITTED → PENDING_APPROVAL → APPROVED → IN_PROGRESS → COMPLETED → CLOSED
```

Alternative states: REJECTED, CANCELLED, ON_HOLD.

Every approval action records Request ID, Approver, Approval Level, Action, Comment, Date/Time, Previous Status and New Status. Approval history must not be deleted.

**Added in v3.0:**
- **Delegation:** when an approver is on leave, they can delegate approvals to another user for a defined date range (audited).
- **Escalation / reminder:** configurable reminder after N days pending; optional escalation to the next level.
- **Configurable per-module workflows** in master data (not hard-coded).

---

## 5b. RBAC Permission Matrix *(NEW in v3.0)*

On top of role-based checks, every API endpoint requires one or more **permissions**. Permissions are database-backed and editable at runtime — no redeploy needed when responsibilities change.

**Implementation:**
- Tables: `permissions` (catalog) + `role_permissions` (role ↔ permission mapping)
- Global `PermissionsGuard` runs after JWT + Role guards; denied requests get **403 Forbidden**
- Login/`/auth/me` responses include the user's effective permission list — the frontend filters menu items and hides unauthorized actions
- Permission Matrix screen (System Admin): checkbox grid of roles × permissions; **SYSTEM_ADMIN locked as superuser**; every change audit-logged (`ROLE_PERMISSIONS_UPDATED`)

**Default catalog (14 permissions):**

| Code | Meaning |
|---|---|
| `users.read` | View user accounts |
| `users.manage` | Create/edit users, roles, reset passwords, edit permission matrix |
| `org.read` | View branches, departments, employees |
| `org.manage` | Manage branches, departments, employees |
| `requests.read.own` | View own requests |
| `requests.read.all` | View all requests (admin view) |
| `requests.create` | Create and submit requests |
| `approvals.act` | Act on pending approvals |
| `workflow.manage` | Configure workflows and delegations admin |
| `fleet.read` | View vehicles and drivers |
| `fleet.manage` | Manage vehicles and drivers |
| `cars.assign` | Assign vehicles/drivers and manage trips |
| `audit.read` | View audit logs |
| `attachments.use` | Upload and download attachments |

**Default role → permissions mapping:**

| Role | Permissions |
|---|---|
| SYSTEM_ADMIN | *all (superuser)* |
| ADMINISTRATION | fleet.read, fleet.manage, cars.assign, requests.read.all, requests.read.own, requests.create, **approvals.act**, attachments.use (8) — *approvals.act added in v3.0.1 (ADMINISTRATION is the CAR_REQUEST workflow approver); org.read/org.manage removed in v3.0.2 — Administration approves requests and assigns vehicles (org data needed on a request travels with the document), CarPanel uses /fleet/*, so Departments/Employees menus and APIs are unnecessary for this role* |
| MANAGEMENT | org.read, requests.read.all, requests.read.own, requests.create, fleet.read, approvals.act, audit.read, attachments.use (8) |
| DEPARTMENT_HEAD | org.read, requests.read.own, requests.create, approvals.act, fleet.read, attachments.use (6) |
| MAINTENANCE_COORDINATOR | org.read, fleet.read, fleet.manage, cars.assign, requests.read.own, requests.create, attachments.use (7) |
| FINANCE | org.read, requests.read.all, requests.read.own, fleet.read, attachments.use (5) |
| EMPLOYEE | requests.read.own, requests.create, attachments.use (3) — *org.read and fleet.read removed in v3.0.1: employees do not browse org/fleet master data, so the Fleet/Departments/Employees menus stay hidden* |
| PURCHASING | org.read, requests.read.own, requests.create, attachments.use (4) |

> **v3.0.3 (2026-09-23):** `announcements.read` (Plan §18) granted to **all roles** including PURCHASING and FINANCE — company notices are visible to every authenticated user; `announcements.manage` + `inventory.read`/`inventory.manage` remain Administration-only. Default grants ship via migration `00000000000027_rbac_announcements_all_roles` + boot-time seed (never overrides matrix edits).

---

## 6. Car Request Workflow

Employee → Car Request → Department Head Approval → Administration → Vehicle Availability → Vehicle/Driver Assignment → Trip → Mileage/Fuel → Completed → Closed

Vehicle master should include vehicle number, type, brand/model, driver, status, current mileage, registration expiry and insurance expiry. Prevent double booking.

Vehicle detail view must show: requests, trips, fuel/mileage history and **maintenance history** (see §14).

---

## 7. Meeting Room Workflow

Employee → Meeting Room Request → Availability Check → Approval (if required) → Reservation → Meeting → Completed

Provide calendar/day/week views and prevent overlapping reservations for the same room.

Room master: name, location, capacity, equipment and status. Equipment may include projector, TV, HDMI, whiteboard and conference system.

---

## 8. Purchase Request & Approval

Requester → Purchase Request → Department Head → Purchasing Review → Management Approval when required → Approved → Purchasing Process

PR header: PR number, request date, requester, department, required date, purpose, priority and attachments.

PR items: item, description, quantity, unit, estimated unit price, estimated amount, specification and attachments.

Approval thresholds should be configurable rather than hard-coded.

**Added in v3.0 — Document Numbering:** a central numbering service generates document numbers, e.g. `PR-2026-0001`, `PO-2026-0001`, `GRN-2026-0001`, `AST-2026-0001`, `MRQ-2026-0001` (maintenance request), `MRC-2026-0001` (maintenance record), `ANN-2026-0001`. Yearly reset is configurable per document type. Numbers are never reused.

---

## 9. Purchasing Process

Approved PR → Quotation Request → Vendor Quotations → Quotation Comparison → Vendor Selection → Purchase Order → Order Sent → Waiting Delivery

Vendor master: name, category, contact person, phone, email, address, payment terms, bank/tax information and active status. *(v3.0: vendor type includes SERVICE_PROVIDER for maintenance.)*

PO should contain PO number, vendor, PO date, expected delivery, payment terms, delivery address, items, quantities, prices, discount, tax and total.

PO states: DRAFT, APPROVED, SENT, PARTIALLY_RECEIVED, FULLY_RECEIVED, CANCELLED.

**Added in v3.0 — Invoice & Payment (for Finance role):** GRN → Invoice registration (vendor, invoice no., date, amounts, PO/GRN link, attachments) → Payment record (date, method, reference, amount) → status tracking UNPAID / PARTIALLY_PAID / PAID. Finance sees purchase/invoice/payment reports; no separate procurement authority.

---

## 10. Goods Received Note (GRN)

PO → Goods Arrived → Receiving Check → Quantity/Quality Check → GRN

Support ordered, received, accepted, damaged, rejected and remaining quantities; partial receiving; serial/batch numbers where needed; receiving notes and attachments.

Completed GRN updates stock for stock-controlled items and can create fixed-asset records for items classified as assets.

---

## 11. Fixed Asset Management

GRN → Is Fixed Asset? → Create Asset → Asset Number/Tag → QR Code → Assignment → Location → Lifecycle Management

Asset fields: asset number, tag, category, brand, model, serial number, purchase date/cost, vendor, warranty end date, department, employee, location and status.

Statuses: IN_STOCK, ASSIGNED, TRANSFERRED, UNDER_REPAIR, RETURNED, LOST, DISPOSED.

Maintain complete immutable asset history for assignment, transfer, return, repair and disposal.

**Added in v3.0 — Asset 360 view:** the asset detail page shows Asset Information, Assignment/Location history, Warranty, **Maintenance History (every maintenance record, newest first)** and Disposal. Assets that are maintainable units appear in the Maintenance module (see §14). Setting an asset to UNDER_REPAIR is linked to an open maintenance request/record.

---

## 12. Inventory / Store

Purchase/GRN → Stock Receive → Available Stock → Stock Issue → Department.

Transaction types: RECEIVE, ISSUE, RETURN, TRANSFER, ADJUSTMENT.

Do not change stock balance directly without a stock transaction. Support minimum stock and reorder level.

**v3.0:** maintenance parts (oil, filters, gas, batteries, spare parts) are inventory items; when used in a maintenance record they are issued from store with transaction purpose MAINTENANCE (see §14). Parts purchased directly for a job are recorded on the record without stock movement.

---

## 13. Maintenance / Repair Request (Corrective)

Request → Admin Review → Technician/Service Provider Assignment → Inspection → Quotation if required → Repair → Cost → Completed → Closed

Categories may include aircon, electrical, plumbing, furniture, building, generator, vehicle and office equipment. Maintain cost and maintenance history.

**v3.0 scope:** this section covers **ad-hoc/breakdown requests from employees**. When a repair task completes, a Maintenance Record is automatically created (see §14) so the history is never lost. Recurring servicing is handled by Preventive Maintenance (§15), not by repeated manual requests.

---

## 14. Maintenance Record Management *(NEW in v3.0)*

### 14.1 Purpose

A Maintenance Record is the **permanent service-history document** for a maintainable unit — a Fixed Asset (Aircon, Generator, UPS, Office Equipment, Building/Facility, Other Equipment) or a Vehicle. Records are created from:

1. A completed Maintenance Request task (corrective), or
2. A completed Preventive Maintenance schedule occurrence, or
3. Direct entry by the Maintenance Coordinator (e.g. recording a past external service).

Records are **append-only**: corrections are made with a new corrective entry, never by silent editing (audit-logged amendments allowed to Administration/System Administrator roles only).

### 14.2 Maintainable Unit Link

Every record links to exactly one maintainable unit:

```
maintenance_record
        ├── object_type = ASSET    → asset_id (Aircon, Generator, UPS, Equipment, Facility)
        └── object_type = VEHICLE  → vehicle_id (Car)
```

Vehicle detail page = requests + trips + fuel + maintenance history. Asset detail page = assignment + warranty + maintenance history (see §11).

### 14.3 Record Contents (generic — applies to all unit types)

| Field | Notes |
|---|---|
| Record No. | Auto: `MRC-2026-0001` |
| Maintainable Unit | Asset (with location) or Vehicle (with vehicle no.) |
| Maintenance Date / Time | |
| Maintenance Type | PREVENTIVE, CORRECTIVE, INSPECTION, WARRANTY_SERVICE, EMERGENCY |
| Category / Sub-type | see §14.4 type lists |
| Problem / Reason | |
| Work Performed | |
| Parts Used | linked to inventory items or free-text; qty, unit price, amount |
| Service Provider | vendor (type SERVICE_PROVIDER) or internal technician |
| Technician | name / internal staff |
| Cost | parts + labor + service + other (see §14.5) |
| Downtime | start/end or hours out of service (optional) |
| Odometer | vehicles only |
| Invoice / Receipt Attachment | mandatory above a configurable cost threshold |
| Warranty Impact | service under warranty? new warranty end date (e.g. replaced part)? |
| Next Maintenance Date | optional; feeds the preventive schedule |
| Next Maintenance Mileage | vehicles only; optional |
| Remarks | |
| Created By / Approved By | |

### 14.4 Category-specific type lists

- **Vehicle:** Oil Change, Tire, Battery, Engine, Brake, Aircon, Transmission, Suspension, Body/Interior, Repair, Inspection, Other.
- **Aircon:** Cleaning, Gas Refill, Repair, Compressor, Electrical, Installation Check, Other.
- **Generator:** Oil/Filter Change, Battery, Load Test, Fuel System, Repair, Other.
- **UPS/Battery:** Battery Replacement, Inspection, Repair, Other.
- **Office Equipment:** Repair, Cleaning, Part Replacement, Other.
- **Building/Facility:** Electrical, Plumbing, Structural, Cleaning, Pest Control, Other.

Type lists are master data (configurable), not hard-coded enums.

### 14.5 Parts & Cost

`maintenance_record` → one or more cost lines: PARTS, LABOR, SERVICE_FEE, TRANSPORT, OTHER — each with amount, currency and optional invoice attachment. Parts lines may reference inventory items (stock issue with purpose MAINTENANCE) or be direct purchases. Total cost rolls up automatically to the unit, category, department and month (for reports, §17).

---

## 15. Preventive Maintenance & Scheduling *(NEW in v3.0)*

### 15.1 Purpose

Move from "fix when broken" to scheduled servicing: Aircon every 3 months, Generator monthly, Car every 5,000 km, UPS inspection every 6 months — with automatic Due / Upcoming / Overdue visibility.

### 15.2 Maintenance Schedule (master data)

| Field | Notes |
|---|---|
| Schedule No. / Name | e.g. "Aircon QC — quarterly cleaning" |
| Maintainable Unit | asset or vehicle |
| Frequency Type | INTERVAL_DAYS / INTERVAL_MONTHS / INTERVAL_KM (vehicles) / INTERVAL_HOURS (generators/UPS runtime) |
| Interval Value | 3 months / 1 month / 5,000 km … |
| First Due | date or odometer baseline |
| Lead Time (notify before) | e.g. 7 days / 500 km before due |
| Checklist Template | optional task checklist per service type (e.g. aircon cleaning steps) |
| Assigned Vendor / Technician | default service provider |
| Estimated Cost | for budgeting |
| Active / Paused | |

### 15.3 Schedule State Machine

```
SCHEDULED → DUE (within lead window) → OVERDUE (past due) → DONE (record completed) → next cycle recomputed
```

- On completion of the linked Maintenance Record, the engine computes the **next due date / next due odometer** from the last service + interval, and writes it back to the schedule.
- Date-based units: `next_due = last_service_date + interval`. Vehicles: `next_due_km = last_service_odometer + interval`, checked against current mileage on every trip update.
- Manual reschedule/postpone is allowed **with a reason** and is audit-logged.
- Pausing (e.g. asset disposed) requires a reason; disposed/lost assets auto-pause their schedules.

### 15.4 Visibility

- **Dashboard widgets:** Today's Due, This Week Upcoming, Overdue count (per role: Administration / Maintenance Coordinator).
- **Calendar view:** monthly PM calendar by unit type and location.
- **Notifications:** to Maintenance Coordinator + Administration when a schedule becomes DUE and again when OVERDUE; escalation to Management if overdue beyond a configurable number of days.
- **PM Compliance KPI:** % of scheduled services completed on time (monthly/yearly).

---

## 16. Service Providers / Vendors & Technician Management *(NEW in v3.0)*

- Reuses the Vendor master (§9) with vendor type SERVICE_PROVIDER and service categories (aircon, generator, vehicle, electrical, plumbing, cleaning…).
- Fields: contract/AGreement no., contract start/end, rate type (per-visit / annual / per-unit), SLA/response time, rating from completed records.
- Internal technicians: staff records flagged as technicians with skill categories.
- Every maintenance record keeps the performing provider + technician → vendor performance (on-time %, repeat-failure rate) is reportable.

---

## 17. Maintenance Reports *(NEW in v3.0)*

- **Maintenance History** — by unit, category, location, department, date range; printable per-asset service card.
- **Cost Report** — by unit / category / vendor / department / month-year; parts vs labor split.
- **Vehicle Maintenance Report** — cost per vehicle, cost per km, service intervals achieved.
- **Equipment Maintenance Report** — aircon/generator/UPS/equipment availability and downtime.
- **Preventive vs Corrective ratio** and **PM Compliance** (on-time completion %).
- **Upcoming Services (30/60/90 days)** — planning view.
- **Monthly / Yearly summary** — exportable (Excel/CSV/PDF).

---

## 18. Administration Announcement

Administration can publish company/office notices from the system.

Examples: office maintenance, meeting room closure, vehicle schedule, water/electricity interruption, holiday notice, safety notice and IT notice.

Fields: announcement number, title, content, category, priority, publish date, start/end date, creator, target, status and attachments.

Categories: GENERAL, OFFICE, FACILITY, TRANSPORT, MEETING_ROOM, MAINTENANCE, SAFETY, HOLIDAY, IT, EMERGENCY, OTHER.

Priority: NORMAL, IMPORTANT, URGENT, EMERGENCY.

Targets: all employees, department, role, specific employee or branch/location.

Lifecycle: DRAFT → SCHEDULED → PUBLISHED → EXPIRED. Expired announcements remain in history.

For important notices, support Read/Acknowledge tracking and show total target/read/unread counts.

---

## 19. Dashboard

- Employee: My Requests, Pending Approvals, Recent Requests, Announcements.
- Department Head: Department Requests, Pending Approvals.
- Administration: Pending Requests, Today's Cars, Meeting Rooms, Pending GRNs, Maintenance.
- **Maintenance Coordinator (new):** Today's/This Week PM due, Overdue services, Open maintenance requests, Recent records. *(new)*
- Purchasing: Pending PR, PO, Delivery, GRN, Invoices due.
- Management: Purchase, Asset, Maintenance cost trend, Department and monthly trend summaries.

---

## 20. Notifications & Attachments

Provide an internal notification center for submitted/approval/approved/rejected/PO/GRN/asset/**maintenance-due/overdue/service-completed** events. Design email integration as an optional future service.

Allow attachments for requests, quotations, PO, GRN, invoice, assets, **maintenance records (invoice/receipt/photos)**, car requests and announcements. Store file metadata in the database and files in persistent storage.

---

## 21. Audit Log

Record user, action, module, record ID, old value, new value, IP address and timestamp.

**v3.0:** the audit log is **append-only** — no user role (including System Administrator in the application) can modify or delete audit records; deletion happens only via documented DBA procedure outside the application. Audit maintenance-record amendments and schedule changes.

---

## 22. Database Entities

### Core
users, roles, permissions, departments, employees, **branches, locations**, approval_workflows, approval_steps, approval_actions, **approval_delegations**, notifications, attachments, audit_logs, **document_sequences**, **invoices, payments** *(new for Finance)*

### Car
vehicles, drivers, car_requests, car_assignments, car_trips, car_expenses

### Meeting
meeting_rooms, meeting_room_equipment, meeting_room_requests, meeting_room_reservations

### Purchasing
purchase_requests, purchase_request_items, vendors, vendor_contacts, **vendor_service_categories**, quotations, quotation_items, quotation_comparisons, purchase_orders, purchase_order_items

### Receiving
goods_receipts, goods_receipt_items

### Inventory
items, item_categories, warehouses, stock_transactions, stock_balances

### Assets
asset_categories, assets, asset_assignments, asset_transfers, asset_repairs, asset_disposals

### Maintenance *(expanded in v3.0)*
- maintenance_requests, maintenance_tasks, maintenance_costs *(existing — corrective requests)*
- **maintenance_records** — permanent service history; links to asset_id or vehicle_id (exactly one)
- **maintenance_record_items** — parts used (inventory item reference or free text, qty, price, amount)
- **maintenance_record_costs** — PARTS / LABOR / SERVICE_FEE / TRANSPORT / OTHER lines
- **maintenance_schedules** — preventive schedule per unit (frequency, interval, first due, lead time, active)
- **maintenance_schedule_runs** — each occurrence: planned date/km, actual completion, status (DUE/UPCOMING/OVERDUE/DONE), link to the created record
- **maintenance_checklist_templates**, **maintenance_checklist_items** — service checklists
- **maintenance_type_options** — configurable category/sub-type lists (§14.4)

### Announcement
announcements, announcement_targets, announcement_reads

### Minor modules (entities added to close v2.0 gaps)
office_supply_requests, office_supply_request_items; travel_requests, travel_expenses; visitors, visits; events, catering_orders.

---

## 23. Environment Separation & Deployment Strategy

MANDATORY: Testing and Production must be separate environments with separate databases, file storage and secrets.

Development → Git repository → CI build (GitHub Actions: lint, test, image build) → Testing Server → QA/UAT → Management/User Acceptance → Production Release.

Testing Server is the place for functional testing and UAT. Real production data must not be used unless explicitly approved and protected.

Production Server must not be manually modified to make application changes. Deploy approved versions from Git/release artifacts (versioned images pushed to the container registry, tagged with the release version).

---

## 24. Docker Deployment Structure

Recommended project structure:

- compose.yaml
- compose.test.yaml
- compose.prod.yaml
- frontend/
- backend/
- database/
- nginx/
- **monitoring/ (uptime checker, log persistence)** *(new)*
- scripts/
- docs/
- uploads/

Use the base Compose configuration plus test/production overrides. Use persistent volumes for PostgreSQL and required file storage.

### 24.1 Deployment note (this project — remember, do not re-discover)

- The Windows working copy and the server directory **are the same files** (Samba share:
  `\\\\192.168.100.110\\admin` = Windows drive `Y:` = `/opt/admin` on the server). Edits made
  from Windows are already on the server — there is **no copy/rsync/git-push step**.
- npm/node **must not** run against the UNC path from Windows (UNC is unsupported). Run all
  builds inside Docker on the server (or via the `Y:` drive when a mapped drive works).
- **One-step deploy** (run on the server, Testing stack):

  ```bash
  cd /opt/admin
  docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test up -d --build
  ```

  This rebuilds both images, restarts the stack, and auto-runs `prisma migrate deploy` + seed.
- Server SSH: `glgadmin@192.168.100.110` (in the `docker` group; see `scripts/server/bootstrap-server.sh`).
- After a frontend deploy, do a **browser hard refresh (Ctrl+Shift+R)** — the old bundle is cached.
- Convention: when a change requires deployment, **deploy immediately in one go** (Testing stack)
  and verify via `/api/health` + the running UI; do not leave builds pending.

---

## 25. Environment Configuration

Testing and Production must have different environment files/secrets. Example variables: APP_ENV, APP_URL, DATABASE_URL, JWT_SECRET, UPLOAD_PATH. Production secrets must never be committed to Git (use a secrets manager or protected environment files deployed out-of-band).

---

## 26. Database Migration Strategy

Use Prisma migrations. Schema changes must be versioned and tested on the Testing database before Production.

Flow: Schema Change → Migration File → Testing DB → Tests/UAT → Approved Release → Production Migration.

Never manually alter the Production schema unless an emergency procedure is documented and audited.

---

## 27. Production Migration Procedure

1. Code Freeze and identify release version.
2. Create full Production backup: database, uploads, configuration and current release information.
3. Verify backup and, where possible, test restoration.
4. Deploy the approved application version.
5. Run only approved Prisma database migrations.
6. Migrate approved master/reference data if required (including maintenance type options, vendor service categories).
7. Restore/migrate application uploads and verify permissions.
8. Start/restart Docker services.
9. Run health checks and smoke tests.
10. Monitor logs, errors and application behavior.
11. Declare Go-Live complete only after verification.

---

## 28. Migration Scripts

Create repeatable scripts:

- backup-production.sh
- backup-database.sh
- restore-database.sh
- deploy-production.sh
- migrate-production.sh
- rollback-production.sh
- health-check.sh

The deployment script should validate version/environment, back up data, deploy the approved release, run migrations, start services, run health checks and report success/failure.

---

## 29. Rollback Strategy

If deployment fails: stop new release → restore previous application version → restore database only when required and safe → restore uploads if needed → run health checks → return service to previous stable version.

Every production release must have a documented rollback point.

---

## 30. Backup & Restore

- **Daily database backup.** Weekly full backup of database + uploads + configuration. Mandatory backup before every Production deployment and database migration.
- **Retention (added in v3.0):** daily backups kept 30 days, weekly backups kept 12 months, monthly backups kept 2 years (configurable).
- Keep a copy in a separate backup location (off-server). Perform periodic restore tests on a non-production environment. A backup is considered reliable only after successful restoration testing.

---

## 31. Security Requirements

- Secure authentication and password hashing.
- Server-side RBAC and authorization.
- Input validation and API validation.
- Rate limiting for authentication endpoints.
- Secure HTTP headers and HTTPS (automated renewal, e.g. Let's Encrypt).
- File type/size validation for uploads.
- Database must not be exposed directly to the public Internet.
- Production secrets must be stored outside source control.
- Audit important administrative and approval actions (append-only, §21).
- Disable debug mode in Production.

**v3.0:** security items (validation, RBAC, rate limiting, secure headers) are **built in from Phase 1**, not deferred to a hardening phase.

---

## 32. Testing & UAT

- Unit and API tests.
- Permission and authorization tests.
- Approval workflow tests.
- Meeting-room and vehicle conflict tests.
- Partial GRN and quantity tests.
- Stock calculation and negative-stock tests.
- Asset lifecycle tests.
- **Maintenance tests (new):**
  - Record creation for asset vs vehicle link validation.
  - Append-only behavior of maintenance records.
  - Parts issue reduces stock via stock transaction; negative-stock prevention.
  - Cost roll-up to reports (parts + labor + service).
  - Schedule engine: date-based due/overdue; km-based due from trip mileage; next-due recomputation after completion.
  - Schedule pause/postpone with reason; auto-pause on disposed asset.
  - DUE/OVERDUE notifications and escalation.
- Announcement targeting/read/expiry tests.
- Attachment upload tests.
- Backup/restore test.
- Production smoke test.

---

## 33. Production Smoke Test

Login → Dashboard → Create Request → Approve → Purchase/Process → GRN → Asset/Inventory → **Create Maintenance Record → PM schedule shows Due/Overdue** → Announcement → Reports → Logout.

---

## 34. Versioning & Release

Use semantic-style versions such as v0.1.0 (development), v0.5.0 (testing), v1.0.0 (first production), v1.1.0 (feature release), v1.1.1 (bug fix). Display application version and environment in the system.

---

## 35. Development Phases

| Phase | Scope |
|---|---|
| Phase 1 | Foundation: authentication, RBAC, users, departments, employees, branches/locations, layout, dashboard, audit log. Security built-in (validation, rate limiting, secure headers). |
| Phase 2 | Reusable workflow/approval engine (+ delegation/escalation), notifications, attachments, document numbering service. |
| Phase 3 | Car Request, vehicles, drivers, assignment, trip, fuel/mileage. |
| Phase 4 | Meeting Room, equipment, calendar, conflict detection. |
| Phase 5 | Purchase Request, vendor, quotation, comparison, PO, invoice & payment. |
| Phase 6 | GRN and Inventory. |
| Phase 7 | Fixed Asset and QR code lifecycle (incl. Asset 360 view with maintenance-history tab). |
| **Phase 8A** | **Maintenance Requests (corrective):** request → approval → assignment → task → cost → completion → auto-create maintenance record. |
| **Phase 8B** | **Maintenance Records & History:** record management (asset/vehicle link, parts, costs, attachments, warranty), service-provider master, per-unit history views. |
| **Phase 8C** | **Preventive Maintenance:** schedules, due/upcoming/overdue engine, next-due recompute, checklists, notifications, dashboard widgets, PM compliance. |
| Phase 9 | Office Supply, Travel, Visitor and Event. |
| Phase 10 | Administration Announcement, maintenance & company reports and analytics. |
| Phase 11 | Security hardening review, backup/restore drills, performance testing, UAT and Production migration. |

---

## 36. Freebuff / AI Development Method

Do not ask the AI builder to create the entire system in one prompt. First analyze the specification, then design architecture and database, then implement one phase at a time.

1. Step 1: Analyze requirements and identify missing requirements.
2. Step 2: Approve architecture and module dependency map.
3. Step 3: Design PostgreSQL schema and ERD.
4. Step 4: Build Foundation.
5. Step 5: Build each business module independently.
6. Step 6: Test every phase on Testing Server.
7. Step 7: Conduct UAT and fix issues.
8. Step 8: Tag the approved release.
9. Step 9: Back up Production.
10. Step 10: Deploy and migrate to Production using the repeatable migration procedure.
11. Step 11: Smoke test, monitor and document Go-Live.

---

## 37. Final Target Architecture

Users → Nginx → React Frontend → NestJS API → PostgreSQL + Persistent File Storage. Source code is managed in Git. Testing and Production use separate environments and secrets. Production is deployed only from an approved release. Database migrations are versioned, backups are mandatory before release, and rollback/restore procedures are documented.

**Maintenance data flow (v3.0):**

```
Fixed Asset / Vehicle (maintainable unit)
        │
        ├── Maintenance Request (corrective) ──┐
        ├── Preventive Schedule (DUE/OVERDUE) ──┤
        │                                       ▼
        │                          Maintenance Record (append-only)
        │                            ├── Parts Used → Inventory stock issue
        │                            ├── Costs (parts/labor/service)
        │                            ├── Service Provider + Technician
        │                            └── Invoice/Photo attachments
        │                                       │
        └── Asset 360 / Vehicle 360 ◄── full history, costs, next due
                                        ▼
                              Maintenance Reports & PM Compliance
```

---

## 38. Go-Live Checklist

- All critical UAT issues closed.
- Management/UAT sign-off completed.
- Release version tagged.
- Production database backup completed.
- Production uploads/configuration backed up.
- Database migration tested.
- Restore procedure verified.
- Production secrets configured.
- HTTPS configured.
- Debug mode disabled.
- Test accounts reviewed/disabled.
- Seed data verified (roles, departments, branches, admin account, maintenance type options).
- Deployment completed.
- Smoke test passed (including maintenance record + PM schedule).
- Monitoring/log review completed.
- Rollback package retained.

---

## Appendix A — v2.0 → v3.0 Change Log

1. **New Maintenance Management module** — Maintenance Request (corrective), Maintenance Record (permanent history), Preventive Maintenance & Scheduling (Due/Upcoming/Overdue engine), Service Providers, Parts & Cost, Maintenance Reports (§13–§17, §22, §35).
2. Maintenance records linked to Fixed Assets and Vehicles; Asset 360 / Vehicle 360 history views (§11, §6).
3. Added missing entities: office supply, travel, visitor, event (§22).
4. Added Invoice & Payment entities to back the Finance role (§9, §22).
5. Added Branch/Location master (§4, §22).
6. Added Maintenance Coordinator role; optional technician portal role (§4).
7. Approval engine: delegation, reminders/escalation (§5).
8. Central document numbering service (§8).
9. Backup retention periods defined (§30).
10. CI/CD (GitHub Actions) and monitoring (uptime + disk alerts) added (§2, §23, §24).
11. Locale/timezone/currency defaults (§2).
12. Audit log made strictly append-only (§21).
13. Seed data requirements and Go-Live additions (§38).
14. Security requirements built in from Phase 1 (§31, §35).

---

*End of Administration Management System Plan — Version 3.0*
