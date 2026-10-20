# GLG Vendor Contracts Module
## Framework Agreement Spec — Draft v0.1 (FOR APPROVAL)

**Status:** DRAFT — awaiting approval
**Date:** 2026-10-20
**Basis:**
- `docs/GLG_Procurement_ERP_Module.md` §5 (explicitly out-of-scope item: "Contract purchase / framework agreements" — spun out to this spec)
- `docs/AMS_Procurement_Management_Complete_Design.md` §44 (advanced controls: "Contract Purchase"), §12–§13 (quoted prices/terms), §35 (procurement controls)
- `Administration_Management_System_Complete_Plan_v3.0.md` §16 (service-provider contracts: contract no., start/end, rate type, SLA) and §9 (vendor master payment terms)

---

## 1. Why

Today a "contract" exists only as memory + free text: `Supplier` carries a note
field, quotations carry a `paymentTerms` string, and nothing links a signed
framework agreement to the POs that draw down against it. Consequences:

- No visibility of committed spend vs. agreed ceilings.
- PO prices are whatever the purchaser typed — a contract price is never checked.
- Contracts silently expire; the org keeps buying at (or off) a dead agreement.

This module makes the framework agreement a first-class, audited document that
the PO flow can reference — without touching the existing PR→PO→GRN→Invoice
lifecycle (the contract is a *reference*, never a gate that can halt operations).

---

## 2. Current state (relevant, shipped)

| Piece | Where | Gap vs this spec |
|---|---|---|
| Supplier master | `suppliers` (name/phone/address/note/isActive) | No contract entity |
| Contact logs | `supplier_contact_logs` | Usable as contract-negotiation trail |
| Quotation payment terms | `quotations.paymentTerms` (free text) | Not linked to a contract |
| PO payment/delivery terms | `purchase_orders.paymentTerms/deliveryTerms` (free text) | Same |
| PO lines with prices | `purchase_order_items.unitPrice` | No contract-price comparison |
| Expiry reminder sweep pattern | fleet `VehicleDocument` + `Notification.dedupeKey` (VMS §6.4) | Reuse for contract end-dates |
| Numbering | `DocumentSequence.next(prefix)` | Add `CTR-YYYYMM-NNNN` |

---

## 3. Workstreams

### C1 — Contract master (design §44 "Contract Purchase", Plan §16)

Data model (migration 57):

```
vendor_contract {
  id            UUID pk
  contractNo   TEXT unique        -- CTR-YYYYMM-NNNN via DocumentSequence
  supplierId   UUID → suppliers
  title        TEXT               -- "Aircon maintenance FY2026-27"
  contractType TEXT               -- FRAMEWORK | SERVICE_AGREEMENT | PRICE_LOCK
  rateType     TEXT               -- PER_ORDER | ANNUAL | PER_UNIT (Plan §16)
  startDate    TIMESTAMP
  endDate      TIMESTAMP          -- drives the expiry sweep (C3)
  slaDays      INT?               -- promised response/delivery days (Plan §16)
  ceilingAmount DECIMAL(12,2)?    -- optional committed-spend cap
  currency     TEXT default 'MMK'
  status       TEXT default 'ACTIVE' -- ACTIVE | EXPIRED | ENDED | TERMINATED
  attachmentId UUID? → attachments    -- the signed document scan
  note         TEXT?
  createdById  UUID → users
  createdAt / updatedAt
}

vendor_contract_item {           -- agreed price list (§12-style per-vendor quote)
  id, contractId FK (cascade), description, unit?, unitPrice DECIMAL(12,2),
  validUntil? TIMESTAMP
}
```

- CRUD under `/api/contracts` — list (supplier/status/date filters + expiry
  badges), detail (items + drawn-down POs + remaining ceiling), create/edit
  (DRAFT-like edits allowed while ACTIVE; status transitions audited).
- `ENDED`/`TERMINATED` require a reason (audited, §36-style exception path);
  deletion guarded like suppliers (§66): refuse when POs reference the contract.
- Attachments reuse the existing attachments module (contract = requestId-less
  owner? → new generic `attachment.ownerType/ownerId` generalization OR link
  via the supplier's contact log; decide at implementation — the simplest
  non-invasive path is a `contractAttachmentId` column as modeled above).

### C2 — PO linkage + price variance (§35 Control extension)

- `purchase_orders.contractId` UUID nullable (migration 57) + PO form picker
  "Draw down from contract" (supplier-locked: picking a contract filters its
  items into the PO lines with contract prices prefilled).
- **Price variance check (warning, never a block):** when a PO line's
  description matches a contract item and `unitPrice` differs, the API returns
  a `contractVariance: [{ line, contractPrice, poPrice, deltaPercent }]` array
  in the create response and stores it on the PO (`varianceDetail Json?`);
  the UI shows an amber warning badge — the PO is still created (operations
  must not halt; the audit trail records the variance).
- **Ceiling check:** if the contract carries `ceilingAmount`, PO create with
  that contract computes Σ existing PO totals + this PO; exceeding the ceiling
  is a **warning** with required confirmation (not a hard block), consistent
  with the variance philosophy; posted to the audit log either way.
- Invoice 3-way match is untouched — the contract is not a match participant.

### C3 — Expiry monitoring (reuse the VMS §6.4 sweep pattern)

- Daily sweep: ACTIVE contracts ending within their reminder window
  (defaults 60/30/14/7 days, configurable per contract like
  `VehicleDocumentType.warningDays` → `vendor_contract.warningDays Int[]`)
  → Notification to PURCHASING + ADMINISTRATION roles with dedupe key
  `contract:<id>:<endDate>:<days>`; expired contracts flip status to EXPIRED
  (audited, idempotent).
- Contracts page shows DUE/EXPIRED badges; Reports "contracts ending soon"
  table (30/60/90-day horizon).

### C4 — Reporting

- **Contract spend:** per contract — Σ drawn-down PO value, remaining ceiling,
  PO count (`GET /reports/procurement/contract-spend?from&to`).
- **Vendor contract summary:** per supplier — active contracts, next expiry,
  total committed (extends the §34 vendor purchase report with a column).

---

## 4. RBAC

New codes (boot-seed pattern, same as payments.*):
- `contracts.read` — PURCHASING, ADMINISTRATION, FINANCE, MANAGEMENT, SYSTEM_ADMIN
- `contracts.manage` — PURCHASING, ADMINISTRATION, SYSTEM_ADMIN

NAV: "Contracts" (icon 📑) next to Suppliers, shown on `contracts.read`.

---

## 5. Acceptance

| Order | Item | Acceptance |
|---|---|---|
| 1 | C1 | CTR-… numbered contract CRUD; ENDED requires reason; delete blocked when POs reference it |
| 2 | C2 | PO from contract prefills prices; ±variance shows warning badge + audit row; ceiling over → confirm modal |
| 3 | C3 | Sweep notifies exactly once per (contract, end date, threshold); expired flips audited; rerun silent |
| 4 | C4 | Contract spend reconciles with PO totals for the same range |

Per project convention: backend node:test suites + vite/tsc build, Testing
deploy + browser e2e, then Production with approval. Spec→impl rows appended
to `docs/AMS_Design_vs_Implementation_Gap_Analysis.md` on ship.

## 6. Out of scope (this draft)

- Auto-generating POs from contracts / blanket-order drawdown schedules
- Multi-supplier (consortium) contracts; contract versioning beyond status
- E-signature integration; legal metadata beyond dates/terms/SLA
- Budget interaction changes (contract ceiling is informational; the §9
  monthly-budget check remains the hard financial gate)
- Payment-milestone schedules (invoices stay GRN-driven per design §22–23)

---

*Draft ends — approve, edit scope, or request changes before implementation.*
