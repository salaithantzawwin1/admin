# AMS — Design vs. Implementation Gap Analysis

> **Scope:** `AMS_DEVELOPMENT_SPEC_v1.2.md` + `AMS_Procurement_Management_Complete_Design.md` compared against the actual AMS codebase (backend `main` @ `eba87c4`, 2026-10-08).
> **Purpose:** Identify what is implemented, what is missing, and recommend an achievable path to close the gaps.
> **Verified against:** `backend/src/*` (21 modules), `backend/prisma/schema.prisma` (50 models), `frontend/src/pages/*`, `.github/workflows/ci.yml`.

---

## 0. Executive Summary (အကျဉ်းချုပ်)

- **ဒီဇိုင်းစာတမ်းနှစ်ခုစလုံးသည် လက်ရှိ codebase နှင့် များစွာ ကွာဟနေပါသည်** — စာတမ်းများက Asset / Account / Invoice / Petty Cash / Procurement အပြည့်အစုံကို ဖော်ပြထားသော်လည်း လက်ရှိတွင် **မည်သည့် model မှ မရှိသေးပါ** (schema.prisma တွင် 43 model ရှိသည့်အနက် ဝန်ဆောင်မှု workflow များသာ အဓိက)။ *(နောက်ဆုံးရအခြေအနေ — 2026-10-08: P1 Purchase Request နှင့် Account/Asset foundation models များ ထည့်သွင်းပြီးဖြစ်သဖြင့် အောက်ရှိ Implementation Progress Log ကို ကြည့်ပါ။)*
- **အားသာချက်**: Approval framework (Procurement §31 တောင်းဆိုချက်)၊ Audit trail (§32)၊ Vendor master၊ Stock ledger၊ Document numbering — အားလုံး **ရှိပြီးသား** ဖြစ်သဖြင့် Procurement phases P3–P10 သည် အခြေခံကောင်းပေါ်တွင် တည်ဆောက်နိုင်သည်။
- **အကြံပြုချက်**: Procurement §44 ရဲ့ P1 (Purchase Request) ကို ပထမဦးစွာ first-class entity အဖြစ် တည်ဆောက်ပါ — ✅ **2026-10-08 တွင် အကောင်အထည်ဖော်ပြီး** (testing stack တွင် deploy + live e2e စစ်ဆေးပြီး၊ production deploy သည် ခွင့်ပြုချက်စောင့်နေဆဲ)။ `SupplierPurchaseDraft → PURCHASE_REQUEST` ယာယီ bridge ကိုလည်း real PR entity ဖြင့် အစားထိုးပြီး ဖြစ်ပါသည်။

---

## 0.1 Implementation Progress Log (ပြင်ဆင်မှု မှတ်တမ်း)

### 2026-10-08

| # | Fix / Feature | Commit | Deployed | Doc status affected |
|---|---|---|---|---|
| 1 | **Meeting request modal UI fix** — added the missing field labels (`Number of attendees *`, `External company / person *`) with proper `htmlFor`/`id` associations, and clamped cleared/NaN attendee counts back to 1. | `e8fdb77` | ✅ Production (:80), live-verified | — |
| 2 | **Car request form UI fix** — clarified the End-time label variants (`End (optional estimate)` / `End * (pick the hour)` / `End (auto from Half Day)`) and added Time slot + Passengers labels. | `398aa37` | ✅ Production (:80), live-verified | — |
| 3 | **Design docs committed with housekeeping** — spec header Version 1.0 → 1.2, OS row corrected to Ubuntu 22.04 LTS (actual VM: 22.04.5), `Decimal(12,2)` convention stated explicitly, Procurement doc Basis/status notes updated (Inventory is live, Vendor = `Supplier`, §10 stock check targets the existing ledger). This gap analysis itself was created and committed in the same commit. | `0dee23b` | n/a (docs only) | §4 items 1–6 closed; R1 done |
| 4 | **Procurement Phase 1 — Purchase Request as a first-class entity (R2 + R4)** — 7 new Prisma models (`PurchaseRequest`, `PurchaseRequestItem`, `Account`, `AccountCategory`, `Asset`, `AssetCategory`, `Location`) + `PurchasePriority` enum (migration `…44_procurement_foundation`); new `backend/src/procurement/` module (create / list mine-vs-all / detail / draft-update guard / account CRUD / supplier-draft bridge, `PR-…` numbering via `DocumentSequence`, approvals via the generic workflow engine); `suppliers.service.ts` now builds a real PR instead of a text description; RBAC `procurement.read` / `procurement.manage` (catalog + DEFAULT_GRANTS + matrix labels); frontend `/procurement` page (cart-style line items, estimated total, Save as Draft / Submit) + `PurchaseRequestPanel` in RequestDetail; 11-case test suite `procurement-pr.test.ts`. | `eba87c4` | ✅ Testing (:8030) + live e2e (`PR-202610-0001` created & submitted to level-1 approval); ⏳ **Production deploy pending user approval** (migration 44 not yet applied to prod DB) | §3 P1 ⚠️→✅; §1.1/§1.2; §2 §14 & §62–64; R2 done, R4 foundation done |

**Next up:** Phase 2 — amount-based approval rules (R3).

### 2026-10-08 (later same day)

| # | Fix / Feature | Commit | Deployed | Doc status affected |
|---|---|---|---|---|
| 5 | **Phase 1 → Production** — deploy-prod.sh ran clean; backend health `ok`, **migration 44 applied to the prod DB** (all 7 procurement tables verified via psql), `/api/procurement/requests` live (401 unauthenticated), UI 200. | `eba87c4` (already on origin) | ✅ **Production (:80)** | §3 P1 → ✅ fully deployed |
| 6 | **Procurement Phase 2 — amount-based approval routing (R3, design §8)** — `ApprovalWorkflow` gained `minAmount`/`maxAmount` bands (migration 45 drops the one-workflow-per-module unique constraint, adds a module+active index); `WorkflowService.workflowFor(docType, amount)` now selects the active workflow whose band contains the PR's estimated total (inclusive bounds), falling back to the module's unbounded default then to GENERIC_REQUEST; submit/approve/reject/return/detail/inbox/cancel/escalation/notifications all resolve the workflow through the same amount-aware path; seed creates the four §8 example PURCHASE_REQUEST bands (≤500K: DH / ≤2M: +Administration / ≤10M: +Finance / >10M: +Management — examples, adjustable per company policy by editing the `approval_workflows` rows); 8-case test suite `workflow-amount-routing.test.ts`. | `b396645` | ✅ deployed to **testing AND production**; live e2e verified on testing: 100K→L1 / 2M→L2 / 2,000,001→L3 / 15M→L4; migration 45 + bands confirmed in both DBs | §3 P2 amount rules → ✅ implemented + deployed; R3 → ✅ done |
| 7 | **Seed fix — workflows/bands now seed outside the demo-data guard** — the §8 band seeding sat inside the once-per-database demo block (and behind the production early-return), so an already-seeded DB never got them; `seedWorkflows()` is idempotent routing data and now runs on every seed in every environment (prod included). | `c672600` | ✅ both stacks re-seeded (bands verified in testing + prod DB) | — |
| 8 | **Cars fix — janitor no longer re-closes Back-at-Office rides (CAR-202610-0022)** — when a driver tapped "🏁 Back at Office" the assignment row stayed `releasedAt: null` (deliberate — the Back-at-Office exemption queries in cars.service rely on that state), but the `releaseExpired` janitor sweep matched those rows at window end, re-completed the request and sent Administration a contradictory "never tapped Back at Office" auto-close notice right after the earlier "🏁 Car available" message. The janitor now has a dedicated back-at-office branch: it only finalises the bookkeeping (releasedAt + statuses) and sends NO duplicate/contradicting notice. Regression test in `cars-fixes.test.ts`. | `24b9f29` | ✅ testing + production | — |

### 2026-10-09

| # | Fix / Feature | Deployed | Doc status affected |
|---|---|---|---|
| 9 | **Phase 2 → Production** — deploy-prod.sh ran clean; backend health `ok`, **migration 45 (workflow amount bands) applied to the prod DB**; band routing live-verified in prod (100K→L1 / 2M→L2 / 2,000,001→L3 / 15M→L4). | `b396645` | ✅ **Production (:80)** — §3 P2 → ✅ fully deployed; R3 → ✅ done |
| 10 | **Cars fix — janitor no longer re-closes Back-at-Office rides (CAR-202610-0022)** — the `releaseExpired` sweep matched rows whose driver had already tapped "🏁 Back at Office" (`releasedAt` deliberately stays null for the Back-at-Office queries), re-completed the request and sent Administration a contradictory "never tapped Back at Office" auto-close notice minutes after the correct "🏁 Car available" message. The janitor now has a dedicated back-at-office branch that only finalises the bookkeeping and sends no duplicate/contradicting notice. Regression test in `cars-fixes.test.ts`. | `24b9f29` | ✅ **testing + production** |
| 11 | **Procurement Phase 3 — PO + GRN (R5, design §15–20)** — `PurchaseOrder`/`PurchaseOrderItem`/`GoodsReceipt`/`GoodsReceiptItem` entities (migration 46) with the §16 status machine (DRAFT→APPROVED→SENT_TO_VENDOR→PARTIALLY/FULLY_RECEIVED→CLOSED, CANCELLED); new `purchase-orders` module: numbered `PO-…`/`GRN-…` via `DocumentSequence`, Control 1 no-approval-no-PO (linked PR must be APPROVED), Control 2 PO-required receiving, over-receiving guard (accepted ≤ ordered per line, partial deliveries via multiple GRNs), close-only-when-fully-received; GRN accepted consumable lines post straight into the EXISTING `StockTransaction` ledger (spec §23 — no parallel stock system); frontend `/purchase-orders` page (PO create from approved PR, line-item editor, detail with acceptance progress, GRN entry with received/accepted/rejected/condition, status actions); 11-case test suite `purchase-orders.test.ts`. | ✅ testing (`:8030`) AND production (`:80`) — `0d1258a`; migration 46 verified in BOTH DBs (4 tables); `/purchase-orders` + `/workflows` API live on both (401 unauth), fresh bundles served | §3 P5/P6 ⚠️Partial/❌→✅ implemented; R5 → ✅ done |

---

## 1. What Exists Today (verified)

### 1.1 Backend modules (`backend/src/`)

| Module | Contents |
|---|---|
| `auth` | JWT, permission catalog, role grants, deny-memory |
| `org` | Branches, departments, employees, login credentials |
| `users` | User accounts, passwords, status |
| `workflow` | **Generic approval engine** — `ApprovalWorkflow`/`ApprovalStep`/`RequestDocument`/`ApprovalAction`, multi-level, delegations, escalation, return, cancel-approved |
| `inventory` | Items, stock ledger (`StockTransaction`), supply requests (cart → fulfill/reject/admin-cancel), restock, low-stock alerts, reorder suggestions, spending/purchase-totals/ledger CSV, movement summary, item images |
| `suppliers` | Vendor master, contact logs, **PO drafts** (`SupplierPurchaseDraft` + lines) → submit now creates a **real PR entity** via the procurement module (2026-10-08) |
| `procurement` | **NEW 2026-10-08 (Phase 1)** — PR create / list / detail / draft-update guard, account & asset lookups, account CRUD, supplier-draft → PR bridge |
| `cars`, `fleet` | Full vehicle request lifecycle + Telegram bot approvals |
| `meeting-rooms` | Rooms, facility master, availability, assignment queue |
| `announcements` | Rich text, targeting, read/ack |
| `notifications` | SSE live reload |
| `attachments` | Generic file attachments (requestId / announcementId) |
| `audit` | AuditLog with severity |
| `numbering` | `DocumentSequence` — doc numbers (e.g. `MTG-202610-0002`) |
| `settings` | Time table, holidays, Telegram config, fleet buffer |
| `telegram` | Join requests, bot bindings |
| `events`, `health`, `prisma`, `util` | Infrastructure |

### 1.2 Prisma schema (50 models)

Present: User/Role/Permission/RolePermission(+Denied), Branch/Department/Employee, AuditLog, ApprovalWorkflow/Step/Action/Delegation, RequestDocument, Notification, Announcement(+Target/Read), DocumentSequence, Attachment, MeetingRoom(+Request), Vehicle/Driver/CarRequest/CarAssignment/CarTrip/CarExpense, VehicleTypeMaster, FacilityMaster, InventoryItem, StockTransaction, Supplier(+ContactLog, PurchaseDraft+Lines), OfficeSupplyRequest, SupplyRequestLine, TelegramJoinRequest, SystemSetting, Account/AccountCategory, Asset/AssetCategory, Location, PurchaseRequest/PurchaseRequestItem *(2026-10-08: Procurement Phase 1)*.

**Absent (from both design docs):** `Invoice`, `InvoiceItem`, `PettyCashTransaction`, `MaintenanceRecord`, `RFQ`, `Quotation`, `QuotationComparison`, `PurchaseOrder` (entity), `GoodsReceipt`, `Payment`, `Budget`. *(2026-10-08: `PurchaseRequest` + `PurchaseRequestItem`, `Account` + `AccountCategory`, `Asset` + `AssetCategory`, `Location` now exist — Procurement Phase 1, migration 44.)*

Note — `schema.prisma` line 2 says: *"(later phases extend this file: purchasing, assets, maintenance...)"* — the deferral is deliberate, and the `RequestDocType` enum already reserves `PURCHASE_REQUEST`, `TRAVEL_REQUEST`, `MAINTENANCE_REQUEST`.

---

## 2. Development Spec v1.2 — Gap Table

| Spec § | Requirement | Status | Notes |
|---|---|---|---|
| §2 | Ubuntu Server 24.04 LTS | ⚠️ Partial | Production VM runs **Ubuntu 22.04.5** (docs/DEPLOYMENT.md). Either upgrade the VM later or correct the spec. |
| §5 | Repository structure | ✅ | Matches (backend/, frontend/, docs/, scripts/). |
| §6 | Dev / Staging / Production | ⚠️ Partial | Dev + Testing + Production share **one VM** (documented, deliberate). No separate staging. |
| §9–12 | NestJS, REST standards, validation | ✅ | Followed (NestJS + class-validator DTOs). |
| §14 | Core entities: Asset, Account, Invoice, PettyCash, Maintenance | ⚠️ Partial | `Account`/`AccountCategory` and `Asset`/`AssetCategory`/`Location` foundation tables now exist (Procurement Phase 1, 2026-10-08); Invoice, PettyCash, Maintenance still missing. |
| §15–16, §22, §34, §39–40 | Asset model, categories, history, UI, lifecycle, transfer | ❌ Missing | Greenfield. Vehicles exist as their own domain (CarRequest/Fleet) — decide whether vehicles join the Asset model or stay separate. |
| §17–19, §30 | Accounting concept (account_id + optional asset_id), transaction status | ❌ Missing | No accounting transaction at all. |
| §20, §35 | Invoice design + UI | ❌ Missing | — |
| §21, §36 | Petty cash | ❌ Missing | — |
| §23 | Avoid duplicate data (transactions = source of truth) | ✅ Followed | StockTransaction / CarExpense / spending CSV aggregate instead of denormalized totals. Keep this principle for procurement. |
| §25 | Money as Decimal | ✅ / ⚠️ | Decimal used (`Decimal(12,2)`); spec illustrative schema says `Decimal(18,2)`. 12,2 caps at ~9.9 billion MMK — acceptable, but align the convention in one place. |
| §26 | Dates & time | ✅ | Asia/Yangon handling (`util/yangonTime`, TZ in compose). |
| §27–28 | Auth + RBAC | ✅ Exceeded | Permission Matrix, deny-memory, per-module codes, delegations. |
| §29 | Audit log | ✅ | Implemented incl. severity + old/new values. |
| §37 | Attachments (metadata + storage) | ⚠️ Minor deviation | Generic `Attachment` exists but links via `requestId`/`announcementId` columns instead of spec's `entityType`/`entityId`. Works; each new owner type needs a migration. Consider switching to entityType/entityId when procurement lands. |
| §41 | Reporting (asset register, cost history, expense, petty cash, vendor reports) | ❌ Missing | Only Inventory spending/ledger CSVs + movement summary. |
| §43 | Pagination | ✅ | `pageSize` used across list endpoints. |
| §44–45 | Search, filtering, indexing | ⚠️ Partial | Indexes exist where needed; no global search. |
| §47 | Seed data | ✅ | Seeded roles/users (sysadmin, admin1, …). |
| §48–51 | Docker, networking, PostgreSQL backup, Nginx | ✅ / ⚠️ | Compose stacks verified; **backup automation not observed** — add a scheduled `pg_dump` (spec §50). |
| §52 | HTTPS | ❌ Not implemented | Production UI serves plain HTTP on :80 (internal LAN). Acceptable short-term; plan TLS termination on Nginx before any external exposure. |
| §53–59 | CI/CD, versioning, tagging, rollback, health | ✅ / ⚠️ | GitHub Actions CI (typecheck + suites) exists; deploy scripts with health checks exist. Image tagging/registry per §57 not used (local builds) — acceptable for single-VM. |
| §60–61 | Logging, error handling | ✅ | Structured backend logging; ApiError pattern on frontend. |
| §62–64 | Testing strategy, critical business tests | ⚠️ Partial | 7 backend test suites + 1 e2e script — procurement PR logic now covered (`procurement-pr.test.ts`, 11 cases, 2026-10-08); invoice/matching logic still untested. |
| §65–66 | Data integrity, soft delete | ⚠️ Partial | Integrity rules followed; **soft delete not used** — entities use status flags (UserStatus, ItemCategory) or hard deletes (e.g. suppliers DELETE endpoint). Decide per spec §66 which entities need `deletedAt`. |
| §67 | Security checklist | ✅ / ⚠️ | JWT, RBAC, upload auth-token; secrets out of git. Password hashing policy worth auditing once. |
| §83–85 | Long-term architecture | — | The "design data model first" principle was followed for each shipped module. |

---

## 3. Procurement Design — Gap Table (by §44 phases)

| Phase | Design § | Requirement | Status | What exists / what's missing |
|---|---|---|---|---|
| **P1** Purchase Request | §5–7 | PR as first-class document: numbered PR, department, requester, required date, priority, justification, **line items** (qty, unit, est. price, account, optional asset), budget code, attachments; statuses DRAFT→SUBMITTED→UNDER_REVIEW→APPROVED→PROCUREMENT | ✅ **Implemented (2026-10-08, on testing)** | `PurchaseRequest`/`PurchaseRequestItem` entities (migration 44) with per-item qty/unit/est. price/account/asset refs, budget code, priority, required date, justification; `PR-…` numbering via `DocumentSequence`; approvals run through the existing workflow engine (DRAFT→PENDING_APPROVAL→…); employee-facing `/procurement` form (cart-style line items, estimated total, Save as Draft / Submit); supplier draft→PR bridge builds a real entity. **Live-verified on testing (`PR-202610-0001` created + submitted to level-1 approval); production deploy pending approval.** |
| **P2** Approval | §8, §31 | Reusable approval framework, amount-based thresholds | ✅ **Implemented** | The generic workflow engine (multi-level steps, delegations, escalation, return/cancel) satisfies §31's "reusable framework" better than the design's sketch. **Amount-based approval rules (design §8) added 2026-10-08** — workflows carry `minAmount`/`maxAmount` bands and PR submissions are routed by estimated total (seeded with the §8 example bands; thresholds are configurable data, not code). |
| **P3** RFQ / Quotation | §11–12 | RFQ with multiple vendors, per-vendor quotations | ❌ Missing | — |
| **P4** Comparison / Vendor selection | §13–14 | Quotation comparison, selection with justification | ❌ Missing | Supplier master + contact logs exist; nothing links a decision to quotations. |
| **P5** Purchase Order | §15–16 | PO entity with tax/discount totals, statuses DRAFT→…→SENT_TO_VENDOR→PARTIALLY_RECEIVED→FULLY_RECEIVED→CLOSED | ✅ **Implemented (2026-10-09)** | `PurchaseOrder`/`PurchaseOrderItem` entities (migration 46) with the §16 status machine, `PO-…` numbering, PO ↔ PR link, Control 1 (no approval no APO), close-only-when-fully-received; frontend `/purchase-orders` page. Tax/discount line totals are a later refinement (unit-level totals exist). |
| **P6** GRN / Receiving | §17–20 | GRN with ordered/received/accepted/rejected qty, **partial deliveries**, quality verification | ✅ **Implemented (2026-10-09)** | `GoodsReceipt`/`GoodsReceiptItem` with received/accepted/rejected qty + condition notes, over-receiving guard (accepted ≤ ordered), partial deliveries via multiple GRNs (status → PARTIALLY_RECEIVED until lines complete), GRN accepted consumable lines post straight into the EXISTING `StockTransaction` ledger; 11-case test suite `purchase-orders.test.ts`. |
| **P7** Invoice + 3-way match | §22–25 | Invoice w/ PO+GRN refs, MATCHED/PARTIAL_MATCH/MISMATCH, invoice approval aligned to DRAFT→SUBMITTED→APPROVED→POSTED | ❌ Missing | — |
| **P8** Payment | §26 | Payment integration (explicitly a *future* module) | ❌ Missing | By design — out of scope until Finance area exists. |
| **P9** Reports / Dashboard | §33–34 | PR/PO/invoice dashboards, vendor purchase report, purchase by account/asset | ⚠️ Partial | Inventory dashboard tiles + spending CSVs exist; procurement-specific reporting needs the P1–P7 entities first. |
| **P10** Advanced controls | §35 | Control 1 no-approval-no-PO; Control 2 PO-required receiving; Control 3 invoice-without-GRN hold; Control 4 invoice ≤ PO amount; Control 5 duplicate invoice (vendor + invoice no.) | ❌ Missing | Depends on P5–P7 entities. Control 5 is a one-line unique constraint — cheap once Invoice exists. |
| — | §36 | Emergency / direct / petty-cash purchase types | ❌ Missing | — |
| — | §37–39 | Petty cash integration; fixed-asset purchase → asset registration | ❌ Missing | No Asset model yet — asset registration end-point of the flow cannot exist. |
| — | §41 | Permission design (procurement codes) | ✅ Implemented | `procurement.read` / `procurement.manage` added to the catalog + DEFAULT_GRANTS (ADMINISTRATION & PURCHASING: read+manage; FINANCE: read) + RbacMatrix labels (2026-10-08), per the docs/DEPLOYMENT.md §3b checklist. |
| — | §32 | Audit trail | ✅ Implemented | AuditLog used consistently (suppliers/inventory/workflow all log). |
| — | §10 | Stock check before purchase | ✅ **Already real** | The office-supply flow (request → store fulfill from stock) implements the "stock available → issue" branch. The design doc calls Inventory a "future module" — that premise is now stale; the procurement stock-check integration point should target the **existing** `InventoryItem`/`StockTransaction`. |

---

## 4. Doc-vs-Doc Inconsistencies (housekeeping)

1. ✅ **Fixed 2026-10-08** — spec header now says Version 1.2, matching the filename.
2. ✅ **Fixed 2026-10-08** — Procurement doc Basis updated to v1.2 with a status note (Inventory live, Vendor = `Supplier`, §10 stock check targets the existing ledger).
3. ✅ **Fixed 2026-10-08** — spec §2 OS row corrected to Ubuntu 22.04 LTS (actual VM: 22.04.5).
4. ✅ **Resolved 2026-10-08** — `Decimal(12,2)` is the stated convention (sufficient for MMK); noted in both docs.
5. ✅ **Resolved 2026-10-08** — `Supplier` accepted as the canonical name for the design docs' *Vendor*.
6. ✅ **Done 2026-10-08** — both design docs (with housekeeping fixes) + this gap analysis committed in `0dee23b`.

---

## 5. Recommendations (prioritized)

### R1 — Commit the design docs + apply housekeeping (effort: hours) — ✅ **DONE 2026-10-08** (`0dee23b`)
Fix §4 items 1–5, then `git add docs/AMS_*.md` and commit. This freezes the contract that later phases build against.

### R2 — Build P1 Purchase Request as a first-class entity (effort: 1–2 weeks) — **highest value** — ✅ **DONE 2026-10-08** (`eba87c4`, deployed to testing + live e2e verified; prod deploy pending approval)
- New Prisma models: `PurchaseRequest` + `PurchaseRequestItem` (qty, unit, est. unit price `Decimal(12,2)`, optional `accountId`, optional `assetId` — nullable until those modules exist, budget code as free text initially).
- Replace the "text description" bridge in `suppliers.service.ts::submitPurchaseDraft` with a real PR (keep the draft → PR conversion as a convenience entry).
- Employee-facing PR form (frontend) reusing the cart pattern from Inventory.
- Statuses already exist on `RequestDocument` (DRAFT/PENDING_APPROVAL/APPROVED/…); map design statuses onto them instead of inventing a parallel state machine.

### R3 — Do NOT build a second approval framework (saves weeks) — ✅ **DONE 2026-10-08** — amount-based rule support (design §8) added to the existing engine via workflow amount bands; PR/PO/Invoice remain `docType`s on `RequestDocument`
Procurement §31's entity (`entityType`/`entityId`/step/approver/status) is already covered by `ApprovalWorkflow`/`ApprovalStep`/`ApprovalAction`. Extend it:
- add **amount-based rule support** (e.g. workflow selection by total amount threshold) to satisfy §8;
- PR/PO/Invoice all become `docType`s on `RequestDocument`, as CAR_REQUEST and MEETING_ROOM_REQUEST already are.

### R4 — Foundation entities before invoice matching (effort: 1–2 weeks) — ⚠️ **Foundation tables DONE 2026-10-08** (`Account`/`AccountCategory`/`Asset`/`AssetCategory`/`Location` created with Phase 1, minimal fields, PR items already reference them optionally; seeding from the spec's category lists still open)
Introduce `Account` (+ `AccountCategory`) and `Asset` (+ category/location) per spec §15–17 with minimal fields, seeded from the spec's category lists. PR items may reference them optionally from day one (R2), and Invoice items require them (spec §18's core principle: *"accounting asks what was spent on; asset asks which asset"*). Vehicles: keep the existing Fleet domain separate initially; consider an `assetId` back-reference later.

### R5 — PO + GRN on the existing stock ledger (effort: 2–3 weeks) — ✅ **DONE 2026-10-09** (`0d1258a`; migration 46 applied and verified in BOTH testing (:8030) and production (:80) DBs, `/api/purchase-orders` + `/api/workflows` live on both stacks, 11-case test suite green)
- `PurchaseOrder`/`PurchaseOrderItem` with the §16 status machine; "no approval, no PO" (Control 1) is a service-level check on the PR status.
- `GoodsReceipt`/`GoodsReceiptItem` (ordered/received/accepted/rejected qty, partial deliveries via multiple GRNs) that **posts stock IN into the existing `StockTransaction` ledger** — never a parallel stock system (spec §23 principle).
- PO-required receiving (Control 2) with an emergency-purchase bypass type (§36).

### R6 — Invoice + 3-way matching + duplicate control (effort: 2–3 weeks)
- `Invoice`/`InvoiceItem` per spec §20 with PO/GRN references; statuses DRAFT→SUBMITTED→APPROVED→POSTED via the existing workflow engine.
- Three-way match service returning MATCHED / PARTIAL_MATCH / MISMATCH (§23); mismatches route to review (Return action already exists in the workflow engine).
- `@@unique([supplierId, invoiceNumber])` for Control 5.

### R7 — Reports and budget later, on real data (effort: ongoing)
Only after P1–P7 entities exist: procurement dashboard tiles (mirror the Inventory pattern), vendor purchase report, purchase-by-account. Budget check (§9) can start as a **per-account monthly budget table + validation hook** in the PR submit path — the design doc itself recommends keeping an integration point rather than a full budgeting module first.

### R8 — Operational hardening (parallel track)
- Automated PostgreSQL backups (spec §50) — none observed.
- Decide soft-delete policy (spec §66) before procurement entities ship — hard-deleting a Supplier with PO/GRN history would break the audit chain; prefer `status: DISABLED` like users.
- Add backend test suites per spec §63 for each new phase (approval gating, 3-way match, partial delivery math) — CI already runs `npm test`.
- Plan TLS termination (spec §52) before the UI leaves the LAN.

---

## 6. Suggested Roadmap (re-sequenced from Procurement §44)

```text
Phase 0  Doc housekeeping + commit (R1)                       — ✅ done 2026-10-08
Phase 1  Account/Asset foundation + PR entity (R2, R4)        — ✅ done 2026-10-08 (testing; prod deploy pending)
Phase 2  Amount-based approval rules (R3)                     — ✅ done 2026-10-08 (testing + prod)
Phase 3  PO + GRN on existing stock ledger (R5)               — ✅ done 2026-10-09 (testing + prod, migration 46 verified both DBs)
Phase 4  Invoice + 3-way match + controls (R6)                — 2–3 weeks
Phase 5  RFQ/Quotation/Comparison (P3/P4)                     — 2 weeks
Phase 6  Budget integration + reports/dashboard (R7)          — ongoing
Phase 7  Payment integration (P8 — with Finance)              — future
```

RFQ/Quotation (P3/P4) is deliberately **after** PO/GRN: for this organization's purchase sizes, a traceable PO→GRN→Invoice chain delivers most of the control value; quotations can be attached as documents (the generic `Attachment` module) until full RFQ workflow is needed.

---

## 7. What the Codebase Already Gets Right (keep)

- **Generic approval engine** — better than per-document approval tables; reuse everywhere.
- **Transactions as source of truth** (spec §23) — no denormalized cost totals.
- **DocumentSequence numbering** — PR/PO/GRN codes should extend this, not invent new schemes.
- **Audit logging discipline** — consistent `AuditLog` usage across modules.
- **RBAC with deny-memory + permission matrix** — procurement codes will inherit mature tooling.
- **Environment separation + deploy scripts + health checks** — rare discipline at this stage.
