# VMS Spec vs. AMS Current System — Gap Analysis

> **Scope:** `Vehicle_Management_System_Complete_Technical_Specification_v1.0.md` (16 Oct 2026, "Proposed for business and technical review") compared against the actual AMS codebase.
> **Purpose:** Show what the spec demands, what AMS already has, what is missing, and recommend an achievable, phased path to close the gaps without rebuilding what works.
> **Verified against:** `backend/src/fleet/*` (354-line controller, 965-line service), `backend/src/cars/*` (controller 242, service 1480, `telegram-car-actions` 1784, `trip-reminders` 743 lines), `backend/src/workflow/workflow.service.ts`, `backend/src/auth/permissions.ts`, `backend/prisma/schema.prisma` (62 models), `frontend/src/pages/Fleet.tsx` (1536), `CarRequests.tsx` (453), `components/CarPanel.tsx` (626), `Dashboard.tsx`, `Reports.tsx`.
> **Last verified:** 2026-10-16, `main @ 07a7407`.

---

## 0. Executive Summary (အကျဉ်းချုပ်)

- **VMS spec သည် AMS ရှိပြီးသား "Cars & Fleet" module အပေါ် အဆောက်အဦးတည်ဆောက်ရန် ရည်ရွယ်ထားခြင်းဖြစ်ပြီး၊ အခြေခ်အကြမ်းပိုင်း အတော်များများ အဆင်သင့်ရှိနေပါပြီ** — Trip request → approval → assign → dispatch → return lifecycle (Telegram driver button loop နှင့်အတူ)၊ shared approval engine (self-approval ban, delegation, escalation, amount bands)၊ audit trail, RBAC matrix, attachments, cron-based reminder suite တို့ကို spec မလိုဘဲ သုံးနေရင်း ရှိနေပါပြီ။
- **အကြီးဆုံး gap မှာ spec ရဲ့ "most important compliance feature" ဖြစ်သော Document Expiry Engine ပင်** — လက်ရှိတွင် `registrationExpiry` / `insuranceExpiry` / `licenseExpiry` ဆိုသည့် column သုံးခုသာ ရှိပြီး **မည်သည့် alert, မည်သည့် dashboard display, မည်သည့် dispatch block မှ မရှိပါ** (registration/insurance နှစ်ခုလုံးကို frontend က မပြပါ — verified: `Fleet.tsx` တွင် "Expiry" စာလုံး မရှိ)။
- **Gap အဓိက ၅ ခု:** ① Document register + expiry alerts + mandatory-doc dispatch block (spec §6 — ❌) ② Maintenance work orders/schedules (§9 — ❌, ရှိတာက unavailability block window ပဲ) ③ Fuel economics — liters/price/efficiency (§10 — ⚠️ amount-only expense) ④ Fleet reports + dashboard cards (§13/§14 — ❌ reports module ထဲတွင် procurement ပဲရှိ) ⑤ Vehicle org scope (company/branch) + lifecycle/archive (§5 — ❌ `Vehicle` တွင် branch/company field မရှိ)။
- **spec မှာ AMS ထက် ပိုကောင်းသည် မရှိ၊ AMS မှာ spec ထက် ပိုအသုံးဝင်သည် ရှိပါသည်** — Telegram driver control loop (✓ Noted / 🚗 Arrived / 🏁 Back at Office / ETA delay), shared trips (တစ်ကားကို request နှစ်ခု sharing), Driver absence + Company Time Table half-day slots, status-renormalization janitor တို့ကို spec က မဖော်ပြထားပေ — **ထိန်းသိမ်းထားရမည်**။
- **အကြံပြုချက်:** spec §27 ရဲ့ priority order ကို လိုက်နာပြီး၊ အဆင့် ၅ ဆင့် (A–E) ခွဲပြီး Phase A (expiry visibility + alerts — ၁-၂ ပတ်) ကို အရင်လုပ်ပါ။ AMS မှာ email service လုံးဝမရှိသေးသဖြင့် spec §6.4 ရဲ့ email channel ကို ပထမ ချန်ထားပြီး dashboard + Telegram ဖြင့် စတင်ပါ (email = ဆုံးဖြတ်ချက်လိုအပ်)။ Spec §25 ဆုံးဖြတ်ချက် ၁၇ ခုအနက် အဓိက ၇ ခုကို စွမ်းဆောင်ရည်မတိုင်မီ အတည်ပြုပါ။

### Scorecard at a glance

| Spec section | Topic | Status |
|---|---|---|
| §4 | Roles, permissions, data scope | ⚠️ Partial (4 codes vs ~26; no company/branch scope) |
| §5 | Vehicle register + specs + lifecycle | ⚠️ Partial (identity fields strong; scope/lifecycle/spec-definitions missing) |
| §6 | **Document register + expiry engine + alerts + dispatch block** | ⚠️ Partial — **Phase A done 2026-10-16** (expiry calc + dashboard/Telegram alerts + dedup in code); register/versions/dispatch block still missing |
| §7 | Driver/vehicle assignment | ⚠️ Partial (trip assignments + stages; no handover/transfers) |
| §8 | Trip request → approval → dispatch → return | ✅ Mostly (strong; mileage validation + distance ✅; inspection/stops missing) |
| §9 | Maintenance & work orders | ❌ Missing (block windows only) |
| §10 | Fuel & mileage | ⚠️ Partial (odometer ✅; fuel = amount-only expense) |
| §11 | Expense ↔ AMS financial integration | ⚠️ Partial (`CarExpense` exists; no Account link/approval/reports) |
| §12 | Approval workflow | ✅ Mostly (engine reusable as-is; VMS templates pending) |
| §13 | Dashboard | ⚠️ Partial (one queue card) |
| §14 | Reporting | ❌ Missing (0 fleet reports) |
| §15 | Logical DB design | ⚠️ Partial (trips/assignments ✅; documents/maintenance/alerts/fuel ❌) |
| §16 | API design | ⚠️ Partial (REST+validation+Swagger ✅; unversioned, fleet lists unpaginated) |
| §17 | Background jobs & notifications | ⚠️ Partial (rich trip crons ✅; no expiry scan, no outbox/retry) |
| §18 | Security & audit | ✅ Mostly (server-side RBAC + audit; HTTPS/file-scan unverified) |
| §19 | Non-functional | ⚠️ Partial (health ✅, timezone ✅; no pagination/backup evidence) |
| §20 | Deployment architecture | ✅ (same Docker/Nginx/Postgres stack) |
| §21 | Migration / data import | ❌ Missing |
| §22 | Testing (expiry/concurrency/scope) | ⚠️ Partial (cars/fleet tests exist; spec's key tests target missing features) |

**Tally:** ✅ Mostly 4 · ⚠️ Partial 12 · ❌ Missing 4 (of 20 scored sections). Phase A of §5 shipped 2026-10-16 (progress log row 19 in `AMS_Design_vs_Implementation_Gap_Analysis.md`); Phases B–E pending.

---

## 1. What exists today (verified)

### 1.1 Data model (`backend/prisma/schema.prisma`)

| Model | Key fields / behavior |
|---|---|
| `Vehicle` | `vehicleNo` (unique = de-facto vehicle code), `vehicleType` (Prisma enum, 12 values), `brandModel`, `capacity`, primary `driverId`, `currentMileage` (Int), status (`AVAILABLE/IN_USE/UNDER_MAINTENANCE/OUT_OF_SERVICE`), **`registrationExpiry`, `insuranceExpiry` (stored, never surfaced)**, `vin` (unique), `fuelType`, `engineNo`, `chassisNo`, `make`, `model`, `year`, `notes`. **No company/branch/department/location, no ownership/purchase/condition, no archivedAt.** |
| `VehicleTypeMaster` | Editable name list driving UI pickers; delete-guarded against usage (deactivate-instead pattern). Not a spec-definition table — no key/type/unit/requiredness. |
| `Driver` | name, phone, `licenseNo`, `licenseExpiry`, status, employee link, **Telegram binding (`telegramChatId`/bind code)** — driver license correctly lives on the driver, per spec §6.1. |
| `VehicleUnavailability` | Planned block windows (service/inspection/repair, free-text reason) — assign/booking flows skip overlapping windows. |
| `DriverAbsence` | Leave windows (FULL/HALF day against Company Time Table); cron auto-restores status. |
| `CarRequest` | Links `RequestDocument` (docType `CAR_REQUEST`, number `CAR-YYYYMM-nnnn`), destination/purpose/dates/timeSlot/passengers/vehicleTypeRequired/pickup/specialRequest, optional dept-head `managerAck`, assigned `vehicleId`/`driverId`, `sharedTripId` (shared trips). |
| `CarAssignment` | Per-request assignment with driver-stage timestamps: `driverNotedAt`, `driverArrivedAt`, `driverBackAtOfficeAt`, `estimatedReturnAt` (ETA), `telegramMessageId`, `releasedAt`. |
| `CarTrip` | `status`, `startMileage`, `endMileage`, `startedAt`, `completedAt`, `remarks`. |
| `CarExpense` | `type` (`FUEL/TOLL/PARKING/REPAIR/OTHER`), `amount Decimal(12,2)`, `expenseDate`, per trip + vehicle. **No quantity/unit price/odometer-at-fill/account/currency/approval.** |

### 1.2 Backend APIs

- **`fleet` module** (`fleet.controller.ts`, `fleet.read`/`fleet.manage`/`fleet.types.manage`): vehicle CRUD (+ delete guarded when assignments/expenses/requests exist — "set to OUT_OF_SERVICE instead"), driver CRUD + employee link + correlated history, vehicle-types CRUD, absences CRUD/cancel, unavailability windows CRUD/cancel, driver Telegram bindings.
- **`cars` module** (`cars.controller.ts`, `cars.assign` + generic `requests.create`/`approvals.act`): create request → workflow; approved-unassigned queue; availability/conflict checks; fleet overview; assign / reassign / release / admin-cancel / admin-shift / ETA; **trip start/complete with odometer validation**; per-trip expenses (create + list); manager-ack; handover view.
- **Odometer controls (verified in `cars.service.ts`):** start mileage ≥ current odometer, end mileage ≥ start mileage, `distance = end − start`, vehicle `currentMileage` updated transactionally, status auto-returns to `AVAILABLE`. Spec §15.5's core integrity rules are already enforced.

### 1.3 Frontend

- `/fleet` (`Fleet.tsx`) — 4 URL-driven tabs: **main** (vehicle + driver master), **absences**, **unavail** (block a vehicle), **setup** (vehicle types). Vehicle modal: number, type, brand/model, capacity, driver, mileage, VIN/engine/chassis/fuel, notes. **No expiry column displayed.**
- `/car-requests` (`CarRequests.tsx` + `CarPanel.tsx`) — requester queue, detail panel with assignment stages, trip start/complete forms, expense entry, administration actions.
- `Dashboard.tsx` — one fleet-related card: approved-unassigned queue count (gated `cars.assign`).
- `Reports.tsx` — **no fleet/vehicle content at all** (reports module = `/reports/procurement` only).

### 1.4 Workflow / approvals (shared engine — spec §12 requirements vs current)

| Spec §12.3 requirement | AMS status |
|---|---|
| Server-side approver resolution from policy | ✅ `ApprovalWorkflow` templates per docType, seeded `CAR_REQUEST → L1 ADMINISTRATION` |
| Cost-threshold routing | ✅ amount bands `minAmount/maxAmount` (procurement §8, reusable for maintenance/fuel) |
| Self-approval prevention | ✅ explicit `ForbiddenException('You cannot act on your own request')` |
| Immutable decisions | ✅ append-only `ApprovalAction` + status history rows |
| Rejection requires reason | ✅ reject path validates reason |
| Delegation with effective dates | ✅ delegations module (+ override test) |
| Escalation & reminders | ✅ hourly escalation crons |
| Approval history view | ✅ inbox/detail + audit log |
| Idempotency keys | ⚠️ not implemented (duplicate-submit guarded by state checks instead) |
| Templates for maintenance/fuel/renewal/disposal/compliance-exception | ❌ N/A — those features don't exist yet; `MAINTENANCE_REQUEST` (`MRQ`) docType + workflow seeded but **unused by any UI/service** |

### 1.5 Notifications & background jobs

- **Channels:** in-app (`NotificationsService.notify/notifyMany`) + **Telegram** (driver messages with inline buttons, admin digests). **No email anywhere** (no nodemailer/SMTP/Resend in `backend/src` — verified).
- **Cron suite (`trip-reminders.service.ts`, `@nestjs/schedule`):** driver unacknowledged nudge (every 30 min), expired-request release + orphaned-driver cleanup, vehicle status renormalization, stale request expiry, T-15 ending-soon nudge, **overdue-running-trip escalation**, day-end digest (17:30), shift-handover digest (17:00), audit breadcrumbs for nudges.
- **Missing vs spec §17:** notification **outbox** with queued/sent/failed states + capped backoff (sends are fire-and-forget with warn-logs), test-notification function. *(Phase A added the daily document-expiry scan with dedup keys — 2026-10-16.)*

### 1.6 RBAC

- Catalog: `fleet.read`, `fleet.manage`, `fleet.types.manage`, `cars.assign` (+ generic `requests.*`, `approvals.act`, `audit.read`, `attachments.use`). Enforcement is server-side per endpoint with the matrix + deny-memory pattern (revocations survive restarts — proven by the recent suppliers work).
- **vs spec §4.3:** ~4 relevant codes vs ~26 suggested `vms.*` codes. No `document.manage`, `trip.dispatch`, `maintenance.*`, `fuel.*`, `expense.*`, `report.export`, `configuration.manage`.
- **Data scope:** `Vehicle`/`CarRequest` carry **no company/branch/department FK**; AMS org master = `Branch` + `Department` only (no Group/Company model). Multi-company scoping per spec §4.2 cannot be expressed today.

---

## 2. Spec-vs-current scorecard (detail)

Legend: ✅ met · ⚠️ partial · ❌ missing.

| Spec | Requirement | St | Current reality / note |
|---|---|---|---|
| §5.1 | `vehicle_code` unique | ✅ | `vehicleNo` unique (format `VH-YGN-0001` is a naming decision, not a gap) |
| §5.1 | `registration_number` | ✅ | `vehicleNo` doubles as plate; duplicate policy = DB unique (spec wants configurable policy — minor) |
| §5.1 | **company/branch required FKs** | ❌ | Not on the model at all; whole-fleet is implicitly one org |
| §5.1 | ownership/purchase/lease/supplier/currency | ❌ | Absent (supplier master exists to link to) |
| §5.1 | make/model/year/color/fuel/VIN/engine/chassis | ✅ | Present (Tier-1 optional fields; `vin` unique) |
| §5.1 | odometer monotonic | ✅ | Enforced at trip start/complete; `Int` km (spec wants DECIMAL — minor) |
| §5.1 | condition, archived_at/By | ❌ | No condition enum, no archive columns (hard delete with usage guard) |
| §5.2 | Category-specific spec definitions (key/type/unit/range) | ❌ | `VehicleTypeMaster` = names only; specs are fixed columns |
| §5.3 | Lifecycle Draft→Active→Restricted→Disposed→Archived + status history | ❌ | 4 operational statuses only; no transitions/history/reason |
| §6.1 | Configurable document types per company/type | ❌ | Fixed columns `registrationExpiry`/`insuranceExpiry` only |
| §6.2 | Document register w/ reference no, authority, versions, renewal lineage, attachment | ❌ | Absent |
| §6.3 | Server-side expiry status (30/14/7/1, DUE_TODAY, EXPIRED, NOT_CONFIGURED) | ✅ | **Phase A (2026-10-16):** shared `expiryStatus()` on Asia/Yangon business dates, computed on vehicle + driver lists; unset date → null (field-level NOT_CONFIGURED) |
| §6.4 | Daily scan + dashboard/email/Telegram alerts + dedup + retry + logs | ⚠️ | **Phase A:** daily 08:30 Yangon cron → in-app + Telegram to `fleet.manage` holders, unique `dedupeKey` dedup (migration 52), dashboard card. **Still missing:** email channel (platform-wide), outbox/retry states, admin test-notification |
| §6.5 | `mandatory_for_dispatch` → block trip approval/dispatch | ❌ | No compliance check in assign/dispatch path |
| §6.1 | Driver license on driver record | ✅ | `Driver.licenseNo/licenseExpiry` — matches spec's recommended placement (expiry not alerted) |
| §7 | Assignment records + history | ⚠️ | `CarAssignment` per trip with stages; primary `driverId`; no permanent/custodian types, no handover odometer/fuel/condition/photos, no transfers |
| §7.3 | Overlap prevention | ⚠️ | Service-level conflict checks in assign/availability; **no DB exclusion constraint** (spec §15.3 asks for transactional/DB-level guarantee) |
| §8.1 | Trip fields (route/stops/passengers/readings/costs) | ⚠️ | destination/purpose/times/passengers ✅; stops, dispatch/return fuel level, tolls/parking per trip (partly via expenses), incident attachments ❌ |
| §8.2 | 11-step workflow incl. allocation + compliance validation | ⚠️ | Steps 1–5, 7–11 implemented; step 6 (document/maintenance/driver-eligibility validation) impossible today |
| §8.3 | Overlap booking prevention, odometer rules, overdue alert, cancel policy | ✅/⚠️ | Odometer ✅, overdue escalation ✅, admin cancel ✅; concurrency = app-level only |
| §9 | Work orders, parts/labor, schedules (date+odometer), downtime, threshold approvals, release-to-service, alerts | ❌ | Only `VehicleUnavailability` windows; `MAINTENANCE_REQUEST` docType seeded but unused |
| §10 | Fuel transactions (liters, unit price, odometer, station, receipt) | ❌ | `CarExpense.type=FUEL` = amount + date only |
| §10.2 | Duplicate/outlier flags, reconciliation qty×price | ❌ | Absent |
| §10.3 | Efficiency (km/L, L/100km) | ❌ | Absent (raw odometer data exists to build on) |
| §11 | Expense ↔ AMS account/transaction link | ⚠️ | `CarExpense` typed+decimal; **no `accountId`** even though Chart of Accounts now exists; no approval, no currency/cost center |
| §11.3 | Cost reports (per vehicle/branch/km, budget vs actual) | ❌ | None |
| §12 | Approval engine | ✅ | See §1.4 — reuse as-is |
| §13.1/2 | Dashboard cards (expiry, maintenance, trips, spend, utilization) | ⚠️ | Queue cards + new “Documents Expiring (30d)” card (Phase A); no charts / maintenance / spend tiles |
| §13.3 | Navigation | ⚠️ | Fleet, Car Requests, Approvals, Notifications, Audit exist; no Documents/Maintenance/Fuel/Expenses sections |
| §14 | 17 reports + exports | ❌ | Zero fleet reports; CSV export pattern exists in budgets module to copy |
| §15 | Entities: documents, doc types, status history, inspections, work orders, fuel, alert policies, outbox, trip events/stops | ❌ | 8 missing entity groups (see §15 table above); trips/assignments/audit/approvals/attachments ✅ |
| §15.3 | DECIMAL money, DATE expiry, UTC timestamps, indexes | ⚠️ | Money decimal ✅; expiry stored as `DateTime` (midnight) not `DATE`; indexes on trip/assignment windows ✅ |
| §16 | Versioned `/api/v1`, pagination, idempotency, Swagger, stable errors | ⚠️ | Swagger decorators + DTO validation + guards ✅; unversioned paths (spec §16 allows AMS conventions); **fleet lists unpaginated** (`findMany`, no `take`) |
| §17 | 8 scheduled jobs | ⚠️ | Trip crons strong ✅; expiry scans, outbox worker, integrity checks ❌ |
| §18 | RBAC, audit, secrets, upload validation, HTTPS | ✅/⚠️ | Server-side authz + fleet audit events ✅; Telegram bind code hidden from lists ✅; HTTPS & upload scanning = deployment question (unverified) |
| §19 | Pagination, p95, backups, observability | ⚠️ | `/api/health` ✅, structured logs ✅; pagination ❌; backup/restore evidence not in repo |
| §20 | Same deployment stack | ✅ | Docker Compose/Nginx/Postgres/NestJS/React — spec literally prescribes AMS's stack |
| §21 | Excel/CSV vehicle import + reconciliation | ❌ | No import tooling |
| §22 | Expiry/concurrency/scope test suites | ⚠️ | `cars-fixes`, `fleet-vehicle-creation`, `telegram-car-request`, workflow tests ✅; expiry/scope/concurrency suites target missing features |

---

## 3. Priority gaps (recommendation detail)

### G1 — Document & Expiry Engine (spec §6) — ❌ — **highest value, start here**
Spec calls this "the system's most important compliance feature"; AMS stores three expiry dates and does nothing with them (registration/insurance aren't even rendered). Build:
1. `vehicle_document_types` (configurable, `mandatoryForDispatch`, warning thresholds) + `vehicle_documents` (reference no, issue/expiry, superseded-by lineage) + reuse `Attachment` (needs a new owner FK — today it only attaches to `requestId`/`announcementId`).
2. One shared server-side `expiryStatus()` helper (NOT_CONFIGURED/VALID/UPCOMING/DUE_TODAY/EXPIRED) using `Asia/Yangon` business date — the UI already has the Yangon-anchored formatter (commit `978bb62`), server-side comparisons must match it.
3. Daily `@Cron` scan → in-app + Telegram alerts with dedup key `document_id+expiry_date+threshold+channel+recipient` (introduce a small outbox table per spec §15.1 — the `notifications` module is the natural home).
4. `mandatoryForDispatch` check inserted into the existing assign/approve path (`cars.service` assign + workflow final-approve hook) — the hook mechanism (`registerFinalApproveHook`) already exists for exactly this.
5. Surface `registrationExpiry`/`insuranceExpiry` in `Fleet.tsx` immediately (zero-schema quick win).

> **Status 2026-10-16 — Phase A shipped:** items 2, 3 (dashboard+Telegram, dedup'd) and 5 done — including the date inputs that were missing from the UI entirely; items 1 and 4 remain Phase B. Tests: `backend/test/fleet-expiry.test.ts` (10 cases). Pending: commit, migration 52 apply, deploy.

### G2 — Maintenance & work orders (§9) — ❌
Wrap the existing `VehicleUnavailability` concept: `vehicle_maintenance_orders` (work-order no via `DocumentSequence`, diagnosis, vendor→`Supplier`, parts/labor line items, downtime timestamps, `nextServiceDate/odometer`) + schedules cron. Reuse the **seeded-but-unused `MAINTENANCE_REQUEST` (`MRQ`) workflow** for approvals and amount bands for cost thresholds; auto-create an unavailability window while a work order is open (trip allocation already respects windows — instant integration). Add release-to-service as the transition back to `AVAILABLE`.

### G3 — Fuel & mileage economics (§10) — ⚠️→✅
Extend `CarExpense` (or add `vehicle_fuel_transactions`): quantity, unit price, odometer-at-fill (validated non-decreasing against `currentMileage`), station/`Supplier`, payment ref, receipt attachment; derive efficiency (km/L) from consecutive accepted odometer readings. Keep `CarExpense` as the operational row; **add `accountId`** linking to the existing Chart of Accounts so fuel/repair costs land in the reports/budget data sets already built for procurement.

### G4 — Reports & dashboard (§13/§14) — ❌
Extend `/reports/procurement` pattern into `/reports/fleet` (or new `reports/fleet` controller): vehicle register, upcoming-expired documents, trip log with distance, fuel efficiency, cost per vehicle/month, downtime. Copy the budgets CSV-export pattern. Dashboard: reuse the existing card layout for expiry/maintenance/pending-trips/spend tiles.

### G5 — Vehicle org scope + lifecycle (§5) — ⚠️/❌
Decide (spec §25 #1): multi-company Group vs **branch-scoped single company** (what AMS's org master actually models). Add `branchId`/`departmentId` to `Vehicle`, server-side scope filtering in `listVehicles`, then lifecycle: `DRAFT/ACTIVE/RESTRICTED/IN_MAINTENANCE/DISPOSED/ARCHIVED` + `vehicle_status_history` (actor/time/from/to/reason) and replace delete-with-guard by archive (keep the guard as belt-and-braces).

### G6 — Permission granularity (§4.3) — ⚠️
Split `fleet.manage` into `fleet.documents.manage`, `fleet.trips.dispatch`, `fleet.maintenance.manage`, `fleet.fuel.manage`, `fleet.expenses.manage`, `fleet.reports.export`, `fleet.config.manage` (keep `fleet.read`), following the RBAC checklist in `DEPLOYMENT.md` §3b (catalog + endpoint guards + matrix labels + DEFAULT_GRANTS + deny-memory compatibility).

### G7 — Email channel (§6.4) — ❌ platform-wide
AMS has **no email service at all**. Either (a) accept dashboard+Telegram as channels 1–2 for release 1 and record the decision, or (b) add a provider (spec §19 leaves it open). Recommendation: (a) first — Telegram adoption among drivers/administration is already high (button-driven flows work), revisit email before group rollout.

### G8 — Trip polish (§8) — ⚠️
Pre/post-trip inspection checklist, dispatch/return fuel level, ordered stops, trip attachments (incident notes), and DB-level overlap guarantee (Postgres exclusion constraint on `vehicle_trips(vehicle_id, during)`) instead of app-level checks only.

### G9 — Import (§21), pagination (§16), NFR hygiene (§19)
CSV/CSV-import for the initial vehicle+document load (spec §21.3's validate→reject-report→reconcile flow), `take`/cursor pagination on fleet lists, and documented backup/restore covering DB **and** attachment volume (spec §24 risk: attachments lost in restore).

---

## 4. AMS strengths the spec does not describe (keep these)

1. **Telegram driver control loop** — inline buttons for ✓ Noted → 🚗 Arrived → 🏁 Back at Office, ETA delay reporting that extends the booking window, re-send/ack tracking (`telegram-car-actions.service.ts`, 1784 lines). Spec §8 only sketches "driver reports problems".
2. **Shared trips** — one car+driver deliberately serving overlapping requests (`sharedTripId`), with overlap-exclusion and partial-release logic. Spec §8.3 says "prevent overlapping bookings"; AMS is smarter: it prevents *conflicts* but allows deliberate sharing.
3. **Operational reminder suite** — unacknowledged-driver nudges, T-15 ending-soon nudge, overdue-running escalation, day-end & shift-handover digests, auto-release janitor, status renormalization. Spec §17 lists 8 jobs; AMS already runs 8 trip-specific ones.
4. **Driver absence + Company Time Table** — half-day slots derived from a configurable timetable, auto status restore.
5. **Non-blocking dept-head acknowledgement** (`managerAck`) alongside the formal approval chain.
6. **Status mirrors + final-approve/cancel hooks** in the workflow engine — the clean insertion point for G1's dispatch block and G2's work-order creation.

---

## 5. Recommended plan (spec §23 adapted to AMS reality)

Spec estimates 8–12 weeks assuming a mostly-greenfield module. AMS already contains the trip/approval/assignment core (spec's Phase 4 ≈ 70% done). Adjusted:

| Phase | Contents | Spec ref | Est. |
|---|---|---|---|
| **A — Compliance quick wins** ✅ **done 2026-10-16** | Show expiry dates in UI (incl. new date inputs — they were unsettable); expiry status helper; daily expiry cron → dashboard+Telegram alerts; alert dedup. *(`fleet.documents` permission split deferred to Phase B — nothing yet to gate.)* | §6.3/6.4 (core) | shipped |
| **B — Document register** | `vehicle_document_types`/`vehicle_documents` + versions + attachments owner FK + renewal flow + `mandatoryForDispatch` block wired into assign/approve + notification outbox w/ retry | §6 full | 2–3 wks |
| **C — Maintenance** | Work orders + line items + schedules (date/odometer) + `MRQ` approval wiring + auto-unavailability + release-to-service + alerts | §9 | 2–3 wks |
| **D — Fuel, expenses, reports, dashboard** | Fuel transaction fields + efficiency + `accountId` link; `/reports/fleet` + CSV; dashboard tiles | §10/§11/§13/§14 | 2–3 wks |
| **E — Scope, lifecycle, import, hardening** | branch/department on vehicles + server scope; status lifecycle + history + archive; CSV import; pagination; concurrency constraint; scope/concurrency/expiry test suites; backup-restore test | §5/§15/§21/§22 | 2–4 wks |

Phases A–D ≈ 7–11 weeks for the spec's priority list (§27); phase E depends heavily on the §25 decisions (multi-company scope is the swing factor — deferring multi-company to a later release saves several weeks).

**Sequencing rationale:** A first because it is the spec's own top-2 priority and needs no schema; B before C/D because the dispatch-block decision affects trip flow; D reuses procurement's account/report/CSV machinery; E last because scope decisions should not block compliance features.

---

## 6. Decisions required (adapted from spec §25 — the blocking subset)

1. **Org scope:** branch-level scoping only, or full Group/Company model? (AMS has `Branch`/`Department`, no `Company` table — spec §3.2 forbids duplicate masters, so either extend org or scope down.)
2. **Which documents are mandatory for dispatch** and which expiry blocks trip approval (spec §6.5 configurability).
3. **Email channel:** defer to Telegram+dashboard (recommended for release 1) or add a provider now.
4. **Vehicle code/plate format & duplicate policy** (`vehicleNo` today is both).
5. **Odometer & fuel units** (Int km today; spec wants DECIMAL + configurable fuel units) and currency handling for expenses.
6. **Alert thresholds/recipients** (spec defaults 30/14/7/1 + daily after expiry are sensible starting values).
7. **Retention & backup scope** (DB + attachments volume together, spec §19/§24).

Non-blocking (spec §25 tail): QR codes, GPS, accident/fine management, tyre/battery — explicitly out of scope for release 1 per §2.3.

---

## 7. Risks specific to this comparison

| Risk | Note | Mitigation |
|---|---|---|
| Existing expiry data quality | `registrationExpiry`/`insuranceExpiry` are optional and likely mostly NULL | NOT_CONFIGURED status makes blanks visible; import phase backfills |
| "Single truth" status quirk | `CarRequest.status` can stay `DRAFT` forever; document status is the source of truth (comment in `cars.service`) | Document mirrors before adding more status consumers |
| App-level concurrency only | Overlap checks are service-level; two simultaneous assigns could race | Postgres exclusion constraint in phase E |
| Scope creep from spec size | 27 sections, 8–12 wks | Phases A–D strictly follow spec §27's own priority list |
| Email expectation mismatch | Spec §6.4 promises email; AMS has none | Record decision #3 in the spec revision before build |
| Two docNumber spaces | `CAR-` numbering vs future `VH-`/work-order numbers | Reuse `DocumentSequence` (pattern proven with `PR-`/`PO-`/`INV-`) |

---

*Generated 2026-10-16 against `main @ 07a7407`. Re-verify §1–§2 after each fleet/cars schema migration.*
