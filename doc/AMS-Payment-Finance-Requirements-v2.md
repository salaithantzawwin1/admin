# AMS — Payment & Finance Status: Revised Requirements (v2)

**Status:** Approved (27 Nov 2026) · P1-1 implemented, deployed to testing only
**Supersedes:** v1 — "Final Requirements and Change List"
**Baseline code:** `/opt/admin` @ `ef0b326` (P1-1 committed on top)
**Related:** `doc/PAYMENT-FINANCE-PROGRESS.md` (what is built, what is left)

Confirmed decisions are marked ✅. Assumptions used to move forward are marked 🟡. Open items are listed in §18 and are **not** to be implemented until answered.

---

## 0. What changed from v1

| Area | v1 | v2 | Why |
|---|---|---|---|
| Payment recording | Two independent paths ("record directly" **and** "from petty-cash expense") | **One write path per funding source.** Petty-cash payments exist only as the product of a linked expense; other sources are payment rows | v1 allowed the same cash payment to be recorded twice (§1 D-2) |
| Funding sources | 4 (`PETTY_CASH`, `COMPANY_CASH`, `COMPANY_BANK`, `PERSONAL`) | **3** — `PERSONAL` removed | Reimbursement is Finance's external process; AMS was being turned into a half-built staff-payable ledger (§6) |
| Reimbursement | `reimbursementStatus`, Reimbursements view, "owes" chip, GL staff payable | **Removed from v2** | Same as above |
| Primary entry point | Invoice detail first | **Petty Cash expense form first** (adds one optional *Invoice* field) | This is what Administration actually does today (§4) |
| `RECORDED` condition | Voucher **+ every invoice line coded** to an expense account | **Voucher only**; missing coding = warning + export block | v1 made Finance depend on Administration's data entry and duplicated the export block |
| Finance surfaces | Finance column and panel always visible | Behind `financeModuleEnabled`, **default off** | Finance may not use AMS at first; an always-`PENDING` column is noise |
| Float balance | Implied trustworthy | **Advisory only**; insufficiency is a warning, never a block | Top-ups are only recorded occasionally today |
| Cancelling a paid invoice | "Payment removal required first" | Confirmed and made explicit: **409 while `paidAmount > 0`**; no refund/reversal concept in v2 | Keeps the audit trail empty of half-true states |
| Phases | Phase 1 (payments + petty-cash link), Phase 2 (finance) | **P1-1** petty-cash link → **P1-2** cash/bank payments → **Phase 2** finance → **Phase 3** optional | Petty cash is where the money actually flows, so the link ships first |

---

## 1. Decision ledger

### 1.1 Confirmed decisions

| ID | Decision | Consequence |
|---|---|---|
| **D-1** ✅ | Three separate status axes: approval (`Invoice.status`), payment to supplier (`paymentStatus`, derived), finance processing (`financeStatus`) | One word no longer carries three meanings |
| **D-2** ✅ | **Single write path per funding source.** `PETTY_CASH` payments can only be produced by linking a petty-cash expense. `POST /payments` rejects `PETTY_CASH` | Double counting is structurally impossible, not merely discouraged |
| **D-3** ✅ | Funding source has **3 values**: `PETTY_CASH`, `COMPANY_CASH`, `COMPANY_BANK` | No staff-payable state in AMS |
| **D-4** ✅ | Administration's current behaviour is preserved: the petty-cash **expense** is the record of paying a shop; v2 only adds an optional invoice link to it | Data entry grows by one optional field, not by a second workflow |
| **D-5** ✅ | Petty-cash float balance is **advisory**: insufficient balance warns, never blocks. Balance is not used by any export or report as an authoritative figure | Wrong float data cannot stop correct work |
| **D-6** ✅ | `RECORDED` requires **only** `voucherNumber` + `voucherDate`. Missing expense-account coding is a non-blocking warning, and the GL export blocks those invoices | Finance is not gated on Administration's coding |
| **D-7** ✅ | `RECORDED` freezes **payment amounts**, not account coding: coding can still be added/corrected afterwards without breaking the audit trail | Export backlog is fixable |
| **D-8** ✅ | All Finance surfaces sit behind `financeModuleEnabled`, **default off**, changeable by `SYSTEM_ADMIN` only | Administration's screens do not change while Finance is absent |
| **D-9** ✅ | An invoice with `paidAmount > 0` cannot be `CANCELLED`/`REJECTED`; payments must be removed first (reason + audit entry). A `RECORDED` invoice's payments cannot be removed at all | No state where an invoice is void but money is still counted |
| **D-10** ✅ | GL export = CSV, two journals (accrual + payment); invoices missing an expense account or AP account are **blocked and listed**, never exported incomplete | Unbalanced journals cannot leave the system |
| **D-11** ✅ | Payments are allowed while an invoice is **not** `CANCELLED`/`REJECTED` (relaxes today's `PAYABLE_STATUSES` guard) | Shop is often paid before approval or before the bill is entered |
| **D-12** ✅ | Personal money and reimbursement are **out of AMS scope in v2**; they stay in Finance's external process. `fundingSource` remains a free `String` so `PERSONAL` can be added additively later | Simplicity now, no migration pain later |

### 1.2 Assumptions in force

| ID | Assumption | If wrong |
|---|---|---|
| **B-1** 🟡 | Petty cash is **one company-wide float** (no per-person float) | A holder field becomes necessary on `TOPUP`/`EXPENSE`; reconciliation moves earlier |
| **Q-1 default** 🟡 | **One payment settles exactly one invoice** (multi-invoice payments not supported in v2) | An allocation table (payment ↔ invoice ↔ amount) must be designed; see §18 |

---

## 2. The three status axes (unchanged core)

| Axis | Field | Values | Source of truth | Who moves it |
|---|---|---|---|---|
| Approval / purchase | `Invoice.status` | `DRAFT`, `SUBMITTED`, `APPROVED`, `POSTED`, `REJECTED`, `CANCELLED` | workflow | Administration |
| **Payment to supplier** | `Invoice.paymentStatus` + `paidAmount` | `UNPAID`, `PARTIALLY_PAID`, `PAID` | **the payments ledger only** | nobody (computed) |
| **Finance processing** | `Invoice.financeStatus` | `PENDING`, `HANDED_OVER`, `RECORDED` | hand-over / voucher | Administration (hand-over), Finance (recorded) — **hidden until the toggle is on** |

Business meaning:

- **POSTED** = "expense recognised, spend booked". It says nothing about whether the shop was paid.
- **Payment to supplier** = "money actually reached the shop for this bill". Never typed by hand.
- **Finance processing** = "where the paperwork sits". Never changes amounts; never changes `POSTED`.

> Worked example — **INV-202611-0016** (500,000 Ks, POSTED, no payments). Today it shows `UNPAID`, which is wrong: the shop has been paid. After v2, Administration links the petty-cash expense that paid the shop and it becomes `PAID` in the same moment. `financeStatus` stays `PENDING`.

---

## 3. Payment status logic

**BR-1 — Payment status is derived, always.**

```
paidAmount   = SUM(payments.amount) for that invoice
outstanding  = invoice.total − paidAmount
paymentStatus = UNPAID            when paidAmount = 0
              = PARTIALLY_PAID    when 0 < paidAmount < total − TOLERANCE
              = PAID              when paidAmount ≥ total − TOLERANCE
```

- `TOLERANCE` is the rounding tolerance already used by `syncRollup`; it stays as-is.
- `syncRollup` remains the **only** writer of `paidAmount` / `paymentStatus`.
- There is no manual override, no "mark as paid" button.
- A correction is delete-and-re-enter with a reason, never an edit that shifts the balance silently.

**BR-1a — What counts as a payment row.** Every row in `Payment` counts. A petty-cash `EXPENSE` reaches the ledger only through the payment row it creates; the expense itself is never summed into `paidAmount`.

---

## 4. Administration payment workflow

Administration's real behaviour today (confirmed): **when a shop is paid, one petty-cash `EXPENSE` is entered in AMS — the invoice is not linked to it.** v2 keeps that behaviour and adds exactly one optional field.

### 4.1 One write path per funding source

| Funding source | Canonical record | Payment row | Entry points |
|---|---|---|---|
| `PETTY_CASH` | `PettyCashTransaction` (`type = EXPENSE`) | created automatically, 1:1 | **(a)** Petty Cash → New expense → optional *Invoice* picker (primary)<br>**(b)** Invoice detail → *Link petty-cash expense* (for expenses already entered)<br>**(c)** Invoice detail → *+ Record payment* with source = petty cash → creates the expense behind the scenes |
| `COMPANY_CASH` | `Payment` row | is the record | Invoice detail → *+ Record payment* |
| `COMPANY_BANK` | `Payment` row (+ reference) | is the record | Invoice detail → *+ Record payment* |

`POST /payments` refuses `fundingSource = PETTY_CASH` (`400 USE_PETTY_CASH_LINK`). There is no second way to create a petty-cash payment, and no way to create a payment from an expense other than the link itself.

### 4.2 Primary flow (petty cash)

1. Administration buys from the shop and pays from the float.
2. In AMS → Petty Cash → **New expense**: payee (shop), amount, date, float account — exactly as today.
3. **New:** optional *Invoice* picker, filtered to that supplier and to invoices not `CANCELLED`/`REJECTED`, each showing its outstanding balance.
4. On save, in a single database transaction: the expense is created **and** the payment row (`fundingSource = PETTY_CASH`, `method = CASH`, `pettyCashTransactionId` = the expense, date = the expense date) is created; the invoice rolls up.
5. If the expense amount exceeds the invoice's outstanding balance, the link is refused (whole-amount only in v2 — no partial allocation).
6. If only the float balance is exceeded, a **warning** is shown and saving proceeds (D-5).

### 4.3 Existing unlinked expenses (backfill of the business fact)

Yesterday's expenses are not auto-matched. On the invoice detail, *Link petty-cash expense* lists that supplier's unlinked expenses; Administration picks the right one and the payment is created. Amount/date guessed matching is deliberately **not** implemented (a wrong guess corrupts `paidAmount`).

### 4.4 Secondary flows (no float involvement)

- **Company cash**: *+ Record payment*, source `COMPANY_CASH`, payer optional, amount/date/method.
- **Company bank**: same, source `COMPANY_BANK`, reference = transfer/cheque number.
- Both are allowed on `DRAFT`/`SUBMITTED`/`APPROVED`/`POSTED` invoices (D-11).
- Neither creates a petty-cash row and neither changes the float balance.

---

## 5. Petty cash and company cash handling

Four events, two ledgers. **Only `PETTY_CASH` moves the float.**

| # | Event | Record | Float | Invoice link |
|---|---|---|---|---|
| 1 | Finance hands petty cash to Administration | `PettyCashTransaction` `type = TOPUP` | ⬆ increases | ❌ never linkable |
| 2 | Administration pays a shop from petty cash | `EXPENSE` → auto `Payment` (`PETTY_CASH`) | ⬇ decreases | ✅ via *Invoice* picker |
| 3 | Administration pays a shop from company cash | `Payment` (`COMPANY_CASH`) + optional payer | — untouched | ✅ from invoice detail |
| 4 | Administration pays a shop by bank transfer | `Payment` (`COMPANY_BANK`) + reference | — untouched | ✅ from invoice detail |

**BR-2 — A top-up is not a payment.** `TOPUP` never creates a payment, never links to an invoice, never changes `paidAmount` or `paymentStatus`.

**BR-2a — Expense funding is implicit.** An expense is, by definition, `PETTY_CASH`. There is no funding-source choice on the petty-cash screen, so company cash cannot be misfiled as float spending.

**BR-2b — Payee convenience.** When an invoice is picked on the expense form, the shop name pre-fills the payee field (still free text). An optional `supplierId` may be stored for reporting.

**BR-2c — Float balance is advisory (D-5).** `balance = opening + ΣTOPUP − ΣEXPENSE`. The panel shows *"may be incomplete — top-ups are not always recorded"*. No export, no guard, no block depends on it. Reconciliation against counted cash is Phase 3.

**BR-2d — Company cash is not a tracked float in v2.** It is only a funding-source label on a payment. Any company-cash balance tracking is Phase 3.

---

## 6. Personal money and reimbursement — out of scope (D-12)

**Decision:** if an employee pays a shop with personal money, Administration records it as an ordinary **company cash payment** (`fundingSource = COMPANY_CASH`) and the employee is repaid manually through Finance's external process. AMS records only the business fact that matters: *the shop was paid*.

| Rule | Statement |
|---|---|
| **BR-3a** | No `PERSONAL` funding source, no reimbursement status, no staff-payable account in v2 |
| **BR-3b** | A personal payment is **never** entered as a petty-cash `EXPENSE` — that would mislabel float spending. It is a payment row only |
| **BR-3c** | `Payment.note` is available to write *"paid personally by Ko Aung — to be reimbursed"*. It is optional and unreported |
| **BR-3d** | `fundingSource` stays a `String`, not an enum, so `PERSONAL` can be added additively later without touching existing rows |

**Accepted limitation:** when personal money was used, the company-cash figure in AMS will not match the physical cash box, because no cash actually left the box. Cash reconciliation is not part of v2 (§19).

---

## 7. Finance status logic (Phase 2, behind the toggle)

| Value | Meaning | Set by | Requires |
|---|---|---|---|
| `PENDING` | with Administration; Finance has not seen it | default | — |
| `HANDED_OVER` | documents physically given to Finance | Administration (`procurement.manage`) | — |
| `RECORDED` | Finance has entered the voucher | Finance (`finance.manage`) | `voucherNumber` + `voucherDate` (D-6) |

**BR-5 — Moving finance status never touches money.** No transition creates, edits, or deletes a payment; none changes `paidAmount` or `paymentStatus`.

**BR-6 — `RECORDED` requires the voucher, not the coding (D-6).** At the moment of recording, invoices whose lines lack an expense account are listed as a **non-blocking warning** (*"3 lines need an account — export will block this invoice"*). The recording succeeds.

**BR-6a — Coding stays editable after `RECORDED` (D-7).** Adding or correcting `InvoiceItem.accountId`, `Supplier.apAccountId`, or account codes after recording is allowed, because it cannot change an amount. Payment rows, by contrast, are frozen.

**BR-6b — `RECORDED` freezes payments.** Deleting a payment (directly or by deleting its petty-cash expense) is refused once `financeStatus = RECORDED`, until the invoice is reverted to `HANDED_OVER` by a Finance user.

---

## 8. Finance readiness — now vs later (D-8)

| Item | Phase | Reason |
|---|---|---|
| `Payment.fundingSource`, payer, `pettyCashTransactionId` | P1-1 / P1-2 | Only Administration knows where the money came from; it cannot be reconstructed later |
| Petty-cash expense ↔ invoice link, auto payment | P1-1 | Removes the double-entry risk at its source |
| Relaxed status guard (D-11) | P1-2 | Shop is often paid before approval |
| `financeStatus`, hand-over, voucher fields | Phase 2 | No value while Finance does not use AMS |
| `finance.*` permissions (read / manage / export) | Phase 2 | Created but unassigned until Finance is onboarded |
| `Supplier.apAccountId`, `FinanceSettings`, account-code enforcement, GL export | Phase 2 | Accounting concerns; Administration must not be asked for them |
| `InvoiceItem.accountId` pickers in Administration's screens | Phase 2 (hidden/optional before) | Accounting information Administration does not have |

**Toggle behaviour (`financeModuleEnabled`, default `false`, `SYSTEM_ADMIN` only):**

- **Off:** no Finance column, no Finance panel, no voucher fields, no GL export menu, no `finance.*` capabilities in the RBAC matrix's active set. Invoice screens look exactly as they do today plus the payment panel.
- **On:** Finance column + filter, invoice Finance panel, hand-over / record actions, GL export screen, RBAC rows.
- Turning it on shows a one-line explanation of what becomes visible. Turning it off never deletes data; it only hides.
- The toggle is a setting, not a migration — no code change is needed on the day Finance starts.

---

## 9. Consolidated business rules

| Rule | Statement | vs v1 |
|---|---|---|
| **BR-1** | `paymentStatus` / `paidAmount` are derived from `SUM(payments.amount)`; `syncRollup` is the only writer | unchanged |
| **BR-1a** | Only payment rows count; a petty-cash expense counts through its payment row, never twice | new |
| **BR-2** | A `TOPUP` is not a payment and never links to an invoice | unchanged |
| **BR-2a** | All petty-cash expenses are `PETTY_CASH` by definition; no funding choice on that screen | new |
| **BR-2b** | Picking an invoice pre-fills the payee with the supplier name; optional `supplierId` is stored | new |
| **BR-2c** | Float balance is advisory; insufficient balance warns, never blocks; never used by export | **changed** |
| **BR-2d** | Company cash is a funding label only, not a tracked float in v2 | new |
| **BR-3** | Payments allowed while status ∉ {`CANCELLED`, `REJECTED`} | **changed** |
| **BR-3a–3d** | Personal money = company cash payment + optional note; no reimbursement state | **changed** |
| **BR-4** | Partial payments are first-class; over-payment blocked by `remaining + TOLERANCE` on every path | unchanged |
| **BR-5** | Finance status never touches money | unchanged |
| **BR-6** | `RECORDED` needs voucher number + date only; missing coding is a warning | **changed** |
| **BR-6a** | Account coding editable after `RECORDED` | new |
| **BR-6b** | Payments frozen at `RECORDED` | new |
| **BR-7** | `fundingSource` mandatory on every new payment (petty-cash payments get it implicitly) | **changed** |
| **BR-8** | ~~Personal money is a reimbursement, not a second payment~~ | **removed** (D-12) |
| **BR-9** | One petty-cash expense ↔ at most one payment, enforced by a unique key; deleting the expense deletes the payment and re-rolls the invoice (audited) | unchanged |
| **BR-10** | POSTED invoices still accept payments and attachments | unchanged |
| **BR-11** | No back-fill assumptions: existing invoices become `PENDING`, existing unlinked expenses stay unlinked, existing payments get a null funding source | unchanged |
| **BR-12** | Administration's workflow gains at most one optional field | unchanged |
| **BR-13** | Single write path per funding source (D-2); `POST /payments` refuses `PETTY_CASH` | **new** |
| **BR-14** | An invoice with `paidAmount > 0` cannot be cancelled or rejected; payments must be removed first, with a reason (D-9) | **new** |
| **BR-15** | A payment identical to an existing one (same invoice, amount and date) triggers a confirmation prompt, never a silent block | **new** |

---

## 10. Data model changes (Prisma)

### 10.1 Phase 1 — `Payment` (additive)

| Field | Type | Default | Purpose |
|---|---|---|---|
| `fundingSource` | `String?` | `null` (legacy → shown as "—") | `PETTY_CASH` / `COMPANY_CASH` / `COMPANY_BANK` |
| `payerUserId` | `String?` (Uuid → User) | — | staff member who physically paid |
| `payerName` | `String?` | — | free text (driver, outsider) |
| `pettyCashTransactionId` | `String?` **@unique** | — | the expense that produced this payment |

Existing `note`, `date`, `amount`, `method`, `reference` are reused as-is. Index on `fundingSource`. **No `reimbursementStatus`.**

### 10.2 Phase 1 — `PettyCashTransaction` (additive)

| Field | Type | Purpose |
|---|---|---|
| `invoiceId` | `String?` (Uuid → Invoice) | the bill this expense settled |
| `supplierId` | `String?` (Uuid → Supplier) | optional supplier link; `payee` text remains |

Indexes: `@@index([invoiceId])`, `@@index([supplierId])`; relation from `Invoice` named `pettyCashExpenses`.

### 10.3 Phase 2 — `Invoice` (additive)

| Field | Type | Default | Purpose |
|---|---|---|---|
| `financeStatus` | `String` | `"PENDING"` | `PENDING` / `HANDED_OVER` / `RECORDED` |
| `financeHandedOverAt` | `DateTime?` | — | when papers went to Finance |
| `financeHandedOverById` | `String?` | — | who handed over |
| `financeRecordedAt` | `DateTime?` | — | when the voucher was recorded |
| `financeRecordedById` | `String?` | — | who recorded |
| `voucherNumber` | `String?` | — | Finance voucher reference |
| `voucherDate` | `DateTime?` | — | voucher date |

Index: `@@index([financeStatus])`.

### 10.4 Phase 2 — supporting tables

- `Supplier.apAccountId String?` — payable account; falls back to the default in `FinanceSettings`.
- `FinanceSettings` (single row): `apAccountId?`, `cashAccountId?`, `bankAccountId?`, `pettyCashAccountId?`, `taxAccountId?`, `currency` (`MMK`).
- `financeModuleEnabled` stored in the existing settings mechanism (not a new table).
- `InvoiceItem.accountId` **stays nullable in the database**; it is required only by the export rule, never by a screen that Administration must fill in.

---

## 11. Migration and back-fill

1. Additive only — no column renamed, no data deleted, no enum changed.
2. Phase 1: `payments.fundingSource` stays `NULL` for existing rows (UI shows "—"); `petty_cash_transactions.invoice_id` stays `NULL` — guessing links by amount/date is forbidden (BR-11).
3. Phase 2: `invoices.finance_status` defaults to `PENDING`; never auto-`RECORDED`, even for POSTED invoices.
4. Existing unlinked expenses are linked manually, invoice by invoice, by Administration.
5. Rollback: drop the added columns/table. Nothing existing reads them, so rollback loses only the new facts.

---

## 12. API changes

| Phase | Method & path | Change | Permission |
|---|---|---|---|
| P1-1 | `POST /petty-cash` (existing) | accept optional `invoiceId`; when present, create expense **+** payment in one transaction (refuse if amount > outstanding) | `pettycash.manage` (unchanged) |
| P1-1 | `POST /petty-cash/:id/link-invoice` (new) | `{ invoiceId }` → create the payment for an existing expense; 409 if already linked or over-paying | `payments.manage` |
| P1-1 | `GET /petty-cash/linkable/:invoiceId` (new, added during build) | unlinked expenses of that supplier, for the picker | `pettycash.read` / `payments.read` / `procurement.read` |
| P1-1 | `DELETE /petty-cash/:id` (existing) | also delete the linked payment and re-roll the invoice, audited; 409 when `RECORDED` | unchanged |
| P1-1 | `POST /invoices/:id/{cancel,reject}` (existing) | 409 when `paidAmount > 0` (D-9) | unchanged |
| P1-1 | `GET /invoices/:id` (existing) | include `payments[]` and `pettyCashExpenses[]` | unchanged |
| P1-2 | `POST /payments` (existing) | accept `fundingSource` (`PETTY_CASH` → 400 `USE_PETTY_CASH_LINK`), `payerUserId`/`payerName`; relax guard to "not CANCELLED/REJECTED" | `payments.manage` |
| P1-2 | `DELETE /payments/:id` (existing) | 409 for `PETTY_CASH` (landed in P1-1), reason required, 409 when `RECORDED` | `payments.manage` |
| P2 | `PATCH /invoices/:id/finance` (new) | `{ status, voucherNumber?, voucherDate? }`; `RECORDED` needs voucher only; returns the coding-warning list | `procurement.manage` (hand-over), `finance.manage` (recorded) |
| P2 | `GET /reports/gl-export` (new) | `?from&to&kind=accrual\|payment\|both&format=csv` → CSV + blocked-invoice report | `finance.export` |
| P2 | `GET/PUT /settings/finance` (new) | toggle + account defaults | `SYSTEM_ADMIN` |
| P2 | `GET /payments/csv` (existing) | add funding source and payer columns | `payments.read` |

---

## 13. UI changes

| Phase | Screen | Change |
|---|---|---|
| P1-1 | Petty Cash → New expense | **optional Invoice picker** (open bills with a balance, shows outstanding); shop name pre-fills payee; warning when float balance is short; linked rows show `→ INV-… · PY-…` |
| P1-1 | Invoice detail | *Payment to supplier* panel: paid / outstanding, payment list (source, method, note), **Link petty-cash expense**, warning when the picked expense exceeds the balance |
| P1-1 | Invoices list | Payment column now truthful; no new column |
| P1-2 | Invoice detail | **+ Record payment** modal — source `COMPANY_CASH` / `COMPANY_BANK`, amount, date, payer, reference |
| P1-2 | Payments page | Funding source and payer columns; CSV updated |
| P2 (toggle on) | Invoices list | Finance column + filter (PENDING grey / HANDED OVER blue / RECORDED green) |
| P2 (toggle on) | Invoice detail | Finance panel: hand over; voucher number + date; mark recorded (warns about uncoded lines but does not block) |
| P2 (toggle on) | Reports → GL export | Date range, journal type, preview, CSV download, blocked-invoice list with reasons and links |
| P2 (toggle on) | RBAC matrix | `finance.read`, `finance.manage`, `finance.export` rows |

---

## 14. GL export specification (Phase 2)

**A. Accrual journal — per POSTED invoice.** Dr expense account per line (qty × unit price) / Cr supplier payable (`Supplier.apAccountId` or the default AP account); a tax line when `tax > 0` and a tax account is configured.

**B. Payment journal — per payment row.** Dr supplier payable / Cr funding account (`pettyCashAccountId` / `cashAccountId` / `bankAccountId` from `FinanceSettings`).

CSV columns: `journal`, `date`, `voucher_no`, `account_code`, `account_name`, `description`, `debit`, `credit`, `currency`, `supplier_code`, `supplier_name`, `invoice_no`, `payment_no`, `funding_source`.

Rules: never export an invoice whose lines lack an account code, whose supplier has no AP account and no default exists, or whose journal would be unbalanced. Those invoices appear in a **blocked list** with the reason and a link. Coding may be fixed after `RECORDED` (BR-6a) and the next export includes it. There is **no staff-payable account** in v2 (D-12).

---

## 15. Edge cases

| Case | Behaviour |
|---|---|
| Shop paid before the bill is entered | Expense recorded first without a link; later linked from the invoice (or the invoice entered as DRAFT and payment recorded). `PARTIALLY_PAID`/`PAID` appear immediately; POSTED later changes nothing |
| Invoice paid in two instalments | Two payments (two expenses, or expense + cash payment); `PARTIALLY_PAID` until the last |
| Company cash, no float | Payment with `COMPANY_CASH`; no petty-cash row; float untouched |
| Personal money | Entered as `COMPANY_CASH` with an optional note; no reimbursement state (D-12) |
| Paid personally and also entered as a petty-cash expense | Impossible by construction: every expense assumes float money; the only way to record personal money is a payment row |
| Invoice cancelled after a payment | Refused with 409; payments removed first, with a reason, audited (D-9) |
| Same payment entered twice | Allowed only after a confirmation prompt (BR-15) |
| Expense amount exceeds the outstanding balance | Link refused; the invoice must be paid in instalments with separate expenses |
| Float balance insufficient | Warning only; save proceeds (D-5) |
| Posting a TOPUP with an invoice selected | Not possible — the link control exists only on `EXPENSE` |
| Deleting an expense whose invoice is `RECORDED` | Refused (once Phase 2 ships `financeStatus`); Finance must revert the invoice first |
| Finance never uses the app | Everything stays `PENDING`; payments and the payment CSV work unchanged |

---

## 16. Revised implementation phases

### P1-1 — Truthful payment via petty cash *(shipped to testing)*

Schema: `Payment.fundingSource/payerUserId/payerName/pettyCashTransactionId`; `PettyCashTransaction.invoiceId/supplierId`. Expense invoice picker + atomic expense/payment creation. Link-existing-expense flow. Cancel/reject guard. Advisory float panel. Audit on removal.
**Exit criteria:** an existing unlinked expense can be linked to INV-202611-0016 and the invoice shows `PAID`; no way exists to create a petty-cash payment without an expense.

### P1-2 — Cash and bank payments

`POST /payments` relaxes the status guard and refuses `PETTY_CASH`; *+ Record payment* modal for `COMPANY_CASH` / `COMPANY_BANK`; payments page columns and CSV; duplicate prompt.
**Exit criteria:** a 500,000 Ks company-cash payment flips the invoice to `PAID`; petty-cash payments still cannot be created here.

### Phase 2 — Finance-ready *(behind the toggle)*

`financeModuleEnabled` + `finance.*` permissions; `financeStatus` + hand-over/recorded + voucher; `Supplier.apAccountId`, `FinanceSettings`, account coding UI; GL export with the blocked list; Finance column and filter.
**Exit criteria:** with the toggle off, Administration sees no change; with it on, a Finance user can hand over and record by voucher alone, and the export refuses uncoded invoices while listing them.

### Phase 3 — optional, decided later

Float reconciliation against counted cash; company-cash float tracking; multi-invoice payments (only if §18 Q-1 says yes); refunds / credit notes.

Each phase is independently shippable. **P1-1 must precede P1-2** — shipping cash/bank payments first would reopen the route by which a petty-cash payment can be created outside the expense ledger.

---

## 17. Acceptance criteria

1. A petty-cash `EXPENSE` of 500,000 Ks linked to INV-202611-0016 produces exactly one payment (`PETTY_CASH`, `CASH`), and the invoice becomes `PAID`.
2. `POST /payments` with `fundingSource = PETTY_CASH` is rejected with `USE_PETTY_CASH_LINK`.
3. Deleting the linked expense deletes the payment and returns the invoice to `UNPAID`, with an audit entry naming who and why.
4. A `TOPUP` never changes any invoice.
5. An expense larger than the invoice's outstanding balance cannot be linked.
6. Payments of 200,000 and 300,000 show `PARTIALLY_PAID` then `PAID`; a 300,000 payment against a 100,000 balance is rejected.
7. `CANCELLED`/`REJECTED` is refused with 409 while `paidAmount > 0`.
8. Entering an identical payment (same invoice, amount, date) prompts for confirmation and is not silently accepted.
9. With `financeModuleEnabled = false`, no Finance column, panel, voucher field, export menu or `finance.*` capability is visible anywhere.
10. With the toggle on, `RECORDED` succeeds with voucher number + date alone, while printing the uncoded-line warning; the invoice then appears in the export blocked list.
11. Account coding can be corrected after `RECORDED`, and payment rows on a `RECORDED` invoice cannot be deleted.
12. Moving finance status changes no amount: `paidAmount` and `paymentStatus` are identical before and after, in both the UI and the audit log.
13. A user without Finance permissions sees no finance field at all, and the Administration workflow gains at most one optional dropdown.

---

## 18. Open questions

| ID | Question | Default until answered |
|---|---|---|
| **Q-1** | Does one shop payment ever cover **two invoices**? If yes, an allocation table (payment ↔ invoice ↔ amount) is required and touches `paidAmount`, the over-payment guard, the petty-cash link and the payment journal | **Not supported** — one payment settles one invoice; Administration records two expenses |

No implementation may rely on a different answer to Q-1.

---

## 19. Known limitations (v2)

- **Personal money and reimbursement** are outside AMS (D-12); company cash in AMS will not match the physical cash box when personal money was used.
- **Float balance is advisory** (D-5); no reconciliation in v2.
- **One payment = one invoice** until Q-1 is answered.
- **No refunds, credit notes or reversals**; corrections are delete-and-re-enter before `RECORDED`.
- **No multi-currency**: MMK only; the CSV carries a currency column for the future.
- **Tax** remains a single invoice-level amount; per-line tax codes are out of scope.
- **No payment-proof attachment** is required by any rule.
