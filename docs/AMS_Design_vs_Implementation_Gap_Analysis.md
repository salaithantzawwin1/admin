# AMS — Design vs. Implementation Gap Analysis

> **Scope:** `AMS_DEVELOPMENT_SPEC_v1.2.md` + `AMS_Procurement_Management_Complete_Design.md` compared against the actual AMS codebase (backend `main` @ `398aa37`, 2026-10-08).
> **Purpose:** Identify what is implemented, what is missing, and recommend an achievable path to close the gaps.
> **Verified against:** `backend/src/*` (20 modules), `backend/prisma/schema.prisma` (43 models), `frontend/src/pages/*`, `.github/workflows/ci.yml`.

---

## 0. Executive Summary (အကျဉ်းချုပ်)

- **ဒီဇိုင်းစာတမ်းနှစ်ခုစလုံးသည် လက်ရှိ codebase နှင့် များစွာ ကွာဟနေပါသည်** — စာတမ်းများက Asset / Account / Invoice / Petty Cash / Procurement အပြည့်အစုံကို ဖော်ပြထားသော်လည်း လက်ရှိတွင် **မည်သည့် model မှ မရှိသေးပါ** (schema.prisma တွင် 43 model ရှိသည့်အနက် ဝန်ဆောင်မှု workflow များသာ အဓိက)။
- **အားသာချက်**: Approval framework (Procurement §31 တောင်းဆိုချက်)၊ Audit trail (§32)၊ Vendor master၊ Stock ledger၊ Document numbering — အားလုံး **ရှိပြီးသား** ဖြစ်သဖြင့် Procurement phases P3–P10 သည် အခြေခံကောင်းပေါ်တွင် တည်ဆောက်နိုင်သည်။
- **အကြံပြုချက်**: Procurement §44 ရဲ့ P1 (Purchase Request) ကို ပထမဦးစွာ first-class entity အဖြစ် တည်ဆောက်ပါ။ လက်ရှိ `SupplierPurchaseDraft → PURCHASE_REQUEST` စနစ်သည် ယာယီ bridge သာဖြစ်ပါသည်။

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
| `suppliers` | Vendor master, contact logs, **PO drafts** (`SupplierPurchaseDraft` + lines) → submit creates a `PURCHASE_REQUEST` document |
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

### 1.2 Prisma schema (43 models)

Present: User/Role/Permission/RolePermission(+Denied), Branch/Department/Employee, AuditLog, ApprovalWorkflow/Step/Action/Delegation, RequestDocument, Notification, Announcement(+Target/Read), DocumentSequence, Attachment, MeetingRoom(+Request), Vehicle/Driver/CarRequest/CarAssignment/CarTrip/CarExpense, VehicleTypeMaster, FacilityMaster, InventoryItem, StockTransaction, Supplier(+ContactLog, PurchaseDraft+Lines), OfficeSupplyRequest, SupplyRequestLine, TelegramJoinRequest, SystemSetting.

**Absent (from both design docs):** `Asset`, `AssetCategory`, `Location`, `Account`, `Invoice`, `InvoiceItem`, `PettyCashTransaction`, `MaintenanceRecord`, `PurchaseRequest` (entity), `RFQ`, `Quotation`, `QuotationComparison`, `PurchaseOrder` (entity), `GoodsReceipt`, `Payment`, `Budget`.

Note — `schema.prisma` line 2 says: *"(later phases extend this file: purchasing, assets, maintenance...)"* — the deferral is deliberate, and the `RequestDocType` enum already reserves `PURCHASE_REQUEST`, `TRAVEL_REQUEST`, `MAINTENANCE_REQUEST`.

---

## 2. Development Spec v1.2 — Gap Table

| Spec § | Requirement | Status | Notes |
|---|---|---|---|
| §2 | Ubuntu Server 24.04 LTS | ⚠️ Partial | Production VM runs **Ubuntu 22.04.5** (docs/DEPLOYMENT.md). Either upgrade the VM later or correct the spec. |
| §5 | Repository structure | ✅ | Matches (backend/, frontend/, docs/, scripts/). |
| §6 | Dev / Staging / Production | ⚠️ Partial | Dev + Testing + Production share **one VM** (documented, deliberate). No separate staging. |
| §9–12 | NestJS, REST standards, validation | ✅ | Followed (NestJS + class-validator DTOs). |
| §14 | Core entities: Asset, Account, Invoice, PettyCash, Maintenance | ❌ Missing | None exist; only User/Role/Permission/Attachment/AuditLog + Vendor-equivalent (Supplier). |
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
| §62–64 | Testing strategy, critical business tests | ⚠️ Partial | 6 backend test suites + 1 e2e script (RBAC deny-memory, delegations, cars/telegram, fleet). No coverage for procurement/invoice logic — add with P1+. |
| §65–66 | Data integrity, soft delete | ⚠️ Partial | Integrity rules followed; **soft delete not used** — entities use status flags (UserStatus, ItemCategory) or hard deletes (e.g. suppliers DELETE endpoint). Decide per spec §66 which entities need `deletedAt`. |
| §67 | Security checklist | ✅ / ⚠️ | JWT, RBAC, upload auth-token; secrets out of git. Password hashing policy worth auditing once. |
| §83–85 | Long-term architecture | — | The "design data model first" principle was followed for each shipped module. |

---

## 3. Procurement Design — Gap Table (by §44 phases)

| Phase | Design § | Requirement | Status | What exists / what's missing |
|---|---|---|---|---|
| **P1** Purchase Request | §5–7 | PR as first-class document: numbered PR, department, requester, required date, priority, justification, **line items** (qty, unit, est. price, account, optional asset), budget code, attachments; statuses DRAFT→SUBMITTED→UNDER_REVIEW→APPROVED→PROCUREMENT | ⚠️ **Partial (bridge only)** | Today a PR is a plain `RequestDocument` with `docType=PURCHASE_REQUEST` whose lines live inside a **text description** built from a Supplier PO draft (`suppliers.service.ts::submitPurchaseDraft`). No PR entity, no per-item prices/accounts, no priority/required-date, no employee-facing PR form. **This is the single biggest gap.** |
| **P2** Approval | §8, §31 | Reusable approval framework, amount-based thresholds | ✅ **Implemented** | The generic workflow engine (multi-level steps, delegations, escalation, return/cancel) satisfies §31's "reusable framework" better than the design's sketch. **Amount-based approval rules are not yet supported** — workflows are per-module static step lists. |
| **P3** RFQ / Quotation | §11–12 | RFQ with multiple vendors, per-vendor quotations | ❌ Missing | — |
| **P4** Comparison / Vendor selection | §13–14 | Quotation comparison, selection with justification | ❌ Missing | Supplier master + contact logs exist; nothing links a decision to quotations. |
| **P5** Purchase Order | §15–16 | PO entity with tax/discount totals, statuses DRAFT→…→SENT_TO_VENDOR→PARTIALLY_RECEIVED→FULLY_RECEIVED→CLOSED | ⚠️ Partial | "PO" today = text inside an approval request. No PO entity, no status machine, no PO ↔ PR link, no totals. |
| **P6** GRN / Receiving | §17–20 | GRN with ordered/received/accepted/rejected qty, **partial deliveries**, quality verification | ❌ Missing | Inventory `restock` (stock IN) exists but is manual and PO-unlinked; no partial-delivery tracking. |
| **P7** Invoice + 3-way match | §22–25 | Invoice w/ PO+GRN refs, MATCHED/PARTIAL_MATCH/MISMATCH, invoice approval aligned to DRAFT→SUBMITTED→APPROVED→POSTED | ❌ Missing | — |
| **P8** Payment | §26 | Payment integration (explicitly a *future* module) | ❌ Missing | By design — out of scope until Finance area exists. |
| **P9** Reports / Dashboard | §33–34 | PR/PO/invoice dashboards, vendor purchase report, purchase by account/asset | ⚠️ Partial | Inventory dashboard tiles + spending CSVs exist; procurement-specific reporting needs the P1–P7 entities first. |
| **P10** Advanced controls | §35 | Control 1 no-approval-no-PO; Control 2 PO-required receiving; Control 3 invoice-without-GRN hold; Control 4 invoice ≤ PO amount; Control 5 duplicate invoice (vendor + invoice no.) | ❌ Missing | Depends on P5–P7 entities. Control 5 is a one-line unique constraint — cheap once Invoice exists. |
| — | §36 | Emergency / direct / petty-cash purchase types | ❌ Missing | — |
| — | §37–39 | Petty cash integration; fixed-asset purchase → asset registration | ❌ Missing | No Asset model yet — asset registration end-point of the flow cannot exist. |
| — | §41 | Permission design (procurement codes) | ⚠️ Partial | `inventory.read/manage`, `suppliers.read/manage` exist. Procurement codes (`procurement.read/manage` etc.) need adding per docs/DEPLOYMENT.md §3b checklist (catalog + DEFAULT_GRANTS + matrix labels + verify script). |
| — | §32 | Audit trail | ✅ Implemented | AuditLog used consistently (suppliers/inventory/workflow all log). |
| — | §10 | Stock check before purchase | ✅ **Already real** | The office-supply flow (request → store fulfill from stock) implements the "stock available → issue" branch. The design doc calls Inventory a "future module" — that premise is now stale; the procurement stock-check integration point should target the **existing** `InventoryItem`/`StockTransaction`. |

---

## 4. Doc-vs-Doc Inconsistencies (housekeeping)

1. **`AMS_DEVELOPMENT_SPEC_v1.2.md` header says "Version: 1.0"** while the filename says v1.2 — align the header.
2. **Procurement doc §2 basis** says *"AMS Development Guide v1.0, 2026-09-24"* and lists Inventory/Consumable Stock/Budget as *future* modules — Inventory (office supplies) is **implemented and live** today; update §2, §9 (Budget), §10 (Stock check) to reflect reality.
3. **Spec §2 OS** says Ubuntu 24.04; production VM is 22.04.5.
4. **Decimal convention**: spec illustrates `Decimal(18,2)`; codebase uses `Decimal(12,2)`. Pick one (12,2 is sufficient for MMK; state it explicitly).
5. **Vendor vs Supplier naming**: spec/procurement docs say *Vendor*; the codebase models `Supplier`. Either alias in docs or accept `Supplier` as the canonical name — the Procurement `Vendor` entity is already satisfied by `Supplier`.
6. **Both documents are untracked in git** — commit them (after the housekeeping fixes) so deploys and reviews have a fixed reference.

---

## 5. Recommendations (prioritized)

### R1 — Commit the design docs + apply housekeeping (effort: hours)
Fix §4 items 1–5, then `git add docs/AMS_*.md` and commit. This freezes the contract that later phases build against.

### R2 — Build P1 Purchase Request as a first-class entity (effort: 1–2 weeks) — **highest value**
- New Prisma models: `PurchaseRequest` + `PurchaseRequestItem` (qty, unit, est. unit price `Decimal(12,2)`, optional `accountId`, optional `assetId` — nullable until those modules exist, budget code as free text initially).
- Replace the "text description" bridge in `suppliers.service.ts::submitPurchaseDraft` with a real PR (keep the draft → PR conversion as a convenience entry).
- Employee-facing PR form (frontend) reusing the cart pattern from Inventory.
- Statuses already exist on `RequestDocument` (DRAFT/PENDING_APPROVAL/APPROVED/…); map design statuses onto them instead of inventing a parallel state machine.

### R3 — Do NOT build a second approval framework (saves weeks)
Procurement §31's entity (`entityType`/`entityId`/step/approver/status) is already covered by `ApprovalWorkflow`/`ApprovalStep`/`ApprovalAction`. Extend it:
- add **amount-based rule support** (e.g. workflow selection by total amount threshold) to satisfy §8;
- PR/PO/Invoice all become `docType`s on `RequestDocument`, as CAR_REQUEST and MEETING_ROOM_REQUEST already are.

### R4 — Foundation entities before invoice matching (effort: 1–2 weeks)
Introduce `Account` (+ `AccountCategory`) and `Asset` (+ category/location) per spec §15–17 with minimal fields, seeded from the spec's category lists. PR items may reference them optionally from day one (R2), and Invoice items require them (spec §18's core principle: *"accounting asks what was spent on; asset asks which asset"*). Vehicles: keep the existing Fleet domain separate initially; consider an `assetId` back-reference later.

### R5 — PO + GRN on the existing stock ledger (effort: 2–3 weeks)
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
Phase 0  Doc housekeeping + commit (R1)                       — 1 day
Phase 1  Account/Asset foundation + PR entity (R2, R4)        — 2–3 weeks
Phase 2  Amount-based approval rules (R3)                     — 1 week
Phase 3  PO + GRN on existing stock ledger (R5)               — 2–3 weeks
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
