# GLG Procurement ERP Module
## Gap-Closure Specification — Draft v0.1 (FOR APPROVAL)

**Status:** APPROVED 2026-10-20 — W1–W5 IMPLEMENTED (Testing :8030 live-verified; Production pending approval). See `AMS_Design_vs_Implementation_Gap_Analysis.md` log rows 24–28.
**Date:** 2026-10-20
**Basis:**
- `docs/AMS_Procurement_Management_Complete_Design.md` (complete lifecycle design, 45 sections)
- `Administration_Management_System_Complete_Plan_v3.0.md` (§8–§10 purchasing, invoice & payment, RBAC)
- `docs/AMS_Design_vs_Implementation_Gap_Analysis.md` (live spec→impl ledger)

> **History:** an earlier working copy of this document (`GLG_Procurement_ERP_Module.md`)
> was lost before being committed; this draft is reconstructed from the two design
> documents above and from the **actually shipped** implementation state (verified on
> Testing :8030 and Production :80 on 2026-10-20). It deliberately does **not** re-specify
> what already works — see §2.

---

## 1. Purpose

The AMS procurement stack already covers the design's full document chain
(Purchase Need → PR → Approval → Budget → RFQ → Quotation → Comparison → Vendor
Selection → PO → GRN → Invoice → 3-Way Match → Invoice Approval). This document
defines the **remaining work required to reach ERP-grade completeness** as defined
by the design doc itself:

1. **Vendor Payments** — the design's §26 integration point (the only lifecycle
   step after "Invoice Approval" that has no implementation).
2. **Procurement Dashboard** — design §33 (consolidated status + purchasing summary).
3. **Purchase-by-Asset report** — design §34 (by-account and by-vendor ship; by-asset does not).
4. **Purchase-type classification** — design §36 (Normal / Emergency / Direct / Petty Cash).
5. *(stretch)* **Vendor evaluation** — design §13/§44.

---

## 2. Current state (shipped & verified — do NOT rebuild)

| Design section | Implementation | Where |
|---|---|---|
| §5–§7 PR + approval | `PURCHASE_REQUEST` via generic workflow engine; **configurable amount bands** (minAmount/maxAmount) per workflow | `workflow/`, `procurement.service.ts` |
| §11–§14 RFQ/quotations/comparison/selection | RFQ lifecycle, per-vendor quotations, comparison table, decision with mandatory justification | `procurement.service.ts`, RFQ/Quotations page |
| §15–§16 PO | `PurchaseOrder` DRAFT→APPROVED→SENT_TO_VENDOR→PARTIALLY/FULLY_RECEIVED→CLOSED; direct POs without PR allowed; **budget check** (BUDGET_EXCEEDED blocks with line list) | `purchase-orders.service.ts` |
| §18–§20 GRN + partial delivery | `GoodsReceipt`/`GoodsReceiptItem` ordered/received/accepted/rejected; multiple GRNs per PO; accepted consumables post stock; asset lines auto-register Assets | `purchase-orders.service.ts`, migration 46/54 |
| §22–§25 Invoice + 3-way match | `Invoice` DRAFT→SUBMITTED→APPROVED→POSTED (+REJECTED/CANCELLED/redraft); MATCHED/PARTIAL_MATCH/MISMATCH per line + header; Control 5 duplicate (supplier+paper no. unique) | `invoices.service.ts` |
| §35 Control 4 | invoice total > remaining PO value → MISMATCH exception | `invoices.service.ts` |
| §39 Asset integration | PO line → registered Asset provenance; GRN creates assets; GRV book value | migration 54, Assets page |
| §37 Petty cash | Append-only TOPUP/EXPENSE ledger, balance = Σtopup−Σexpense, CSV | `pettycash/`, Petty Cash page |
| §34 Reports (partial) | Tiles (PR/PO/invoice flow), **vendor purchase report**, **purchase by account**, budget vs actual | `Reports.tsx`, `/reports/procurement/*` |
| §41 Permission design | RBAC: procurement.read/manage, assets.read/manage, pettycash.read/manage, budget guards | `permissions.ts`, RBAC matrix |
| §66 delete guards | PO delete blocked when GRN/invoice linked | migration 54 |
| Numbering/audit | PR-/PO-/GRN-/INV-/AST-/PC- via atomic DocumentSequence; append-only audit | `numbering/`, `audit/` |

---

## 3. Workstreams

### W1 — Vendor Payments (design §26, Plan §9 "Invoice & Payment for Finance")

**Why:** the lifecycle ends at POSTED invoice; Finance cannot record or track
payments, and "Pending Payment" (§33 summary) has no data source.

**Data model (migration 55):**

```
payment {
  id             UUID pk
  paymentNumber  TEXT unique        -- PY-2026-XXXX via DocumentSequence
  invoiceId      UUID → invoices
  date           TIMESTAMP
  amount         DECIMAL(12,2) CHECK (amount > 0)
  method         TEXT               -- BANK_TRANSFER / CASH / CHEQUE / OTHER
  reference      TEXT?              -- transaction ref / cheque no.
  note           TEXT?
  createdById    UUID → users
  createdAt      TIMESTAMP
}
```

- Invoice gains derived **paymentStatus** (computed, never hand-edited):
  `UNPAID` (Σ payments = 0) → `PARTIALLY_PAID` (0 < Σ < total) → `PAID` (Σ ≥ total).
  Stored as a denormalized column updated inside the same transaction as the
  payment write (index for the payables report), plus `paidAmount` rollup.
- Payment is **append-only**: wrong payment = delete (audited, `payments.manage`)
  and re-enter — consistent with the petty-cash ledger convention.
- Control: payment amount may not exceed the invoice remaining balance
  (over-payment rejected with 400).
- Only `APPROVED` or `POSTED` invoices accept payments (design §26 flow).

**API** (`/api/invoices/:id/payments` + `/api/payments`):
- `GET /payments?from&to&supplierId&status` — payment register
- `POST /invoices/:id/payments` — record payment (recomputes paymentStatus)
- `DELETE /payments/:id` — audited removal
- `GET /reports/procurement/payables` — outstanding: supplier, invoice, total,
  paid, balance, dueDate, days-overdue bucket

**RBAC:** new `payments.read` (FINANCE, MANAGEMENT, SYSTEM_ADMIN),
`payments.manage` (FINANCE, SYSTEM_ADMIN). Payments are Finance's authority
only — Administration records invoices but cannot mark them paid.

**UI:** Payments page (register + record-payment modal from invoice detail);
invoice list/detail shows paymentStatus chip + paid/balance columns; payables
(outstanding) table on Reports page.

**Tests:** payment lifecycle (unpaid→partial→paid), over-payment rejected,
payment on DRAFT invoice rejected, RBAC (ADMINISTRATION 403 on manage),
delete audited, payables totals, concurrent payment race.

### W2 — Procurement Dashboard (design §33)

Single page combining, from real data:
- **PR status counts** (Draft/Pending approval/Approved/Rejected/Completed)
- **PO status counts** (Draft/Pending/Sent/Partially received/Fully received/Closed)
- **Invoice states** (Pending match/Matched/Mismatch/Approved/Posted) + paymentStatus split once W1 lands
- **Purchasing summary tiles:** This-month purchase · Pending purchase · Outstanding PO value · Pending GRN · Pending invoice · Pending payment (W1)

Backend: one `GET /reports/procurement/summary` aggregating the counts (no N+1
per-tile queries). Frontend: Procurement nav section top link, tiles + status tables.

### W3 — Purchase-by-Asset report (design §34)

Per asset: purchase cost (PO line/GRN), consumable cost (invoice items linked
to that asset), maintenance cost (future hook — maintenance module), total.
Backend `GET /reports/procurement/by-asset?from&to`; rendered next to the
existing by-account table on Reports.

### W4 — Purchase-type classification (design §36)

- `purchaseType` on PurchaseRequest + PurchaseOrder: `NORMAL` (default) /
  `EMERGENCY` / `DIRECT` / `PETTY_CASH` — migration 55, default NORMAL keeps
  every existing row valid.
- EMERGENCY/DIRECT require `emergencyReason` (validated server-side) — the
  design's Control 2 exception path (receiving without the full PR chain) is
  already possible via direct POs; this makes the exception **visible and audited**
  rather than implicit.
- PR form + PO form: type selector with reason field when non-normal; badge in
  lists; audit records the type.
- PETTY_CASH type is display-only classification — the actual petty-cash money
  movement stays in the petty-cash ledger (§37); linking field `pettyCashId`
  is out of scope for this draft.

### W5 (stretch) — Vendor evaluation (design §13/§44)

Vendor performance derived from live documents (no manual rating entry):
PO count, total value, avg delivery lateness (expectedDelivery vs first GRN
receivedAt), reject rate (rejectedQty/orderedQty), on-time-invoice count.
`GET /reports/procurement/vendor-performance`; column set on the existing
vendor purchase report. No schema change.

---

## 4. Implementation order & acceptance

| Order | Workstream | Acceptance |
|---|---|---|
| 1 | W1 Payments | e2e: POSTED invoice → 3 payments (partial/partial/full) → PAID; overpay 400; payables lists overdue correctly; RBAC matrix row live |
| 2 | W2 Dashboard | every tile traceable to an underlying list page filter |
| 3 | W3 by-asset report | totals reconcile with PO/GRN/invoice sums for the same range |
| 4 | W4 purchase types | emergency PO carries reason; badge visible; audit row contains type |
| 5 | W5 vendor performance | lateness/reject numbers match manual count on test data |

Per project convention: backend tests (node:test) + frontend build/lint, deploy
to Testing immediately, verify in browser, then Testing sign-off → Production
deploy via `deploy-prod.sh` with pre-deploy backup. Spec→impl rows appended to
`docs/AMS_Design_vs_Implementation_Gap_Analysis.md` when each workstream ships.

## 5. Explicitly out of scope (this draft)

- Contract purchase / framework agreements, recurring/scheduled purchases (§44 advanced)
- Multi-currency (schema stays MMK DECIMAL(12,2))
- General-ledger posting / journal export (accounting remains future per Plan §9)
- PETTY_CASH flow linkage beyond classification (W4 display-only)
- Email/notification channels beyond the existing in-app notification service

---

*Approved 2026-10-20 and implemented same day (commits `c824e98` + docs commit). All five workstreams live-verified on Testing; §4 acceptance criteria met (W1 e2e PAID lifecycle, W2 tiles traceable to list pages, W3 totals reconcile, W4 reason validation 400/201, W5 numbers match GRN manual count).*
