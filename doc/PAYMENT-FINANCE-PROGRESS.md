# Payment & Finance — Progress Record

**Last updated:** 27 Nov 2026
**Requirements:** `doc/AMS-Payment-Finance-Requirements-v2.md` (approved)
**Environment:** **P1-1 and P1-2 are deployed to both stacks and verified by API.**
- TESTING — `http://192.168.100.110:8030`, API `127.0.0.1:3011`, build `61e07cc`
- PRODUCTION — `http://192.168.100.110/` (`:80`), API `127.0.0.1:3000`, build `61e07cc`

Production was rebuilt and migrated on 27 Nov 2026 (migration `00000000000093_petty_cash_invoice_link` applied 06:06 UTC; DB backed up to `backups/ams-prod_2026-11-27_123624.sql.gz` immediately before). Both stacks now run the same checkout.

---

## 1. Where the project stands

| Phase | Scope | State |
|---|---|---|
| **P1-1** | Petty-cash expense ↔ invoice link + auto payment, cancel/reject guard, advisory float, supplier guard on the link | ✅ **Done — testing + production, verified by API** |
| **P1-2** | Company cash / bank payments (`+ Record payment`), funding source, relaxed status guard, payer + reference, duplicate confirmation, payments-page columns and CSV, deletion reason | ✅ **Done — testing + production, verified by API** |
| **Phase 2** | `financeModuleEnabled` toggle, `financeStatus` + voucher, `finance.*` RBAC, `Supplier.apAccountId`, `FinanceSettings`, GL export + blocked list | ⏳ Not started |
| **Phase 3** | Float reconciliation, company-cash tracking, multi-invoice payments, refunds | ⏳ Not decided |

---

## 2. P1-1 — the petty-cash link

### Schema (additive, migration `00000000000093_petty_cash_invoice_link`)

- `petty_cash_transactions.invoiceId`, `.supplierId` (+ FKs, indexes)
- `payments.fundingSource`, `.payerUserId`, `.payerName`, `.pettyCashTransactionId` **UNIQUE** (+ FK, index)

No column renamed, no row deleted, no enum changed. Existing rows keep `NULL` (no guessed links).

### Backend

| File | Change |
|---|---|
| `src/procurement/payment-rollup.ts` (new) | `syncInvoiceRollup(tx, invoiceId)` + `PAYMENT_TOLERANCE` — the one writer of `paidAmount`/`paymentStatus`, shared by every write path |
| `src/pettycash/pettycash.service.ts` | Expense accepts `invoiceId`: validates the bill (not cancelled/rejected, has a balance, amount ≤ balance), then writes **expense + payment + rollup in one transaction**. `linkInvoice()` links an existing expense — and **refuses it when the expense's supplier (stored id, else payee name) is not the bill's supplier**. `linkable()` feeds the link dialog, `openBills()` feeds the expense form. `remove()` deletes the payment with the expense and re-rolls the invoice, two audit entries, reason required |
| `src/pettycash/pettycash.controller.ts` | `POST /petty-cash` accepts `invoiceId`; `POST /petty-cash/:id/link-invoice`; `GET /petty-cash/linkable/:invoiceId`; `GET /petty-cash/open-bills`; `DELETE` takes `{ reason }` |
| `src/procurement/payments.service.ts` | Uses the shared rollup; `DELETE /payments/:id` refuses a `PETTY_CASH` payment (409 — delete the expense instead) |
| `src/procurement/invoices.service.ts` | Cancel/reject refused (409) while `paidAmount > 0` (BR-14); `GET /invoices/:id` returns `payments[]` and `pettyCashExpenses[]` |

Payment rows created by the link: `fundingSource = PETTY_CASH`, `method = CASH`, `date` = expense date, `reference` = expense code, `pettyCashTransactionId` = the expense.

### Frontend

| Screen | Change |
|---|---|
| Petty Cash | Expense form has an optional **Invoice paid** picker (open bills with a balance, showing outstanding), reloaded from the server each time the form opens; picking one pre-fills the payee; saving is blocked only when the amount exceeds the invoice balance, not the float. Ledger rows show `→ INV-… · PY-…`. Delete dialog explains that the payment goes with it and requires a reason |
| Invoice detail | **Payment to supplier** panel: paid / outstanding, payment list (source, method, note), **Link petty-cash expense** with the unlinked-expense picker |

### What the old picker got wrong (fixed in P1-2)

The form's *Invoice paid* dropdown used to read the first page of `/invoices` (`pageSize=100`) and cache it for the whole session. A bill entered after the page had loaded — or simply the 101st invoice — never appeared. It now calls `GET /petty-cash/open-bills`, which filters and sorts on the server and is fetched on every open.

---

## 3. P1-2 — company cash and bank payments

| File | Change |
|---|---|
| `src/procurement/payments.service.ts` | `fundingSource` is **mandatory** (`COMPANY_CASH`/`COMPANY_BANK`); `PETTY_CASH` is refused with `400 USE_PETTY_CASH_LINK` (D-2/BR-13). The lifecycle guard is relaxed to "not `CANCELLED`/`REJECTED`" (BR-3/D-11) and the outstanding list follows the same rule. An identical payment (same invoice, amount and **day**) answers `409 DUPLICATE_PAYMENT` naming the existing `PY-` code, and is only written when re-sent with `confirmDuplicate: true` (BR-15). Payer (`payerUserId`, validated if given, or free-text `payerName`) is stored and audited. `DELETE` **requires a reason**, kept in the audit entry's `newValue` (D-9/BR-14). CSV gains `Funding source` and `Paid by` |
| `src/procurement/payments.controller.ts` | `RecordPaymentDto` gains `fundingSource`, `payerUserId`, `payerName`, `confirmDuplicate`; `DeletePaymentDto` carries the reason |
| `frontend/src/pages/Payments.tsx` | *+ Record payment* has a **Paid from** select (company bank / company cash), **Paid by** and reference; the register shows **Source** (badged; legacy rows as `—`) and **Paid by**; deleting opens a dialog whose confirm button stays disabled until a reason is typed; a duplicate raises a "record it again?" confirmation instead of an error banner |
| `frontend/src/pages/Invoices.tsx` | The *Payment to supplier* panel gained **+ Record payment** (source, amount, date, method, paid by, reference) so a bill can be settled without leaving it |
| `frontend/src/components/ConfirmDialog.tsx` | `noteRequired` — the confirmation stays disabled while the reason is empty |

There is still **no edit** for a money row: a correction is delete (with a reason) and re-enter.

---

## 4. Shipped alongside (not part of the payment phases)

Invoice **bill attachments**: their own *Attachments* tab on the invoice detail, uploads frozen once the bill is `POSTED`, and a `📎 no bill` flag on POSTED invoices that still have no file (`b41158c`, `ef0b326`).

---

## 5. Verification (testing stack, 27 Nov 2026)

Typecheck: backend `tsc --noEmit` ✅, frontend `tsc -b` ✅. Images built from the deployed checkout (provenance check passes), migration 93 applied, health 200.

Service tests (all green):

| Test file | Cases | Result |
|---|---|---|
| `backend/test/payments.test.ts` | 16 | ✅ funding source mandatory, `USE_PETTY_CASH_LINK`, relaxed guard, payer, duplicate prompt, delete reason + audit, PETTY_CASH delete 409, payables, CSV columns |
| `backend/test/petty-cash.test.ts` | 7 | ✅ ledger, totals, reason-required deletion |
| `backend/test/petty-cash-link.test.ts` | 7 | ✅ supplier guard (mismatch refused, payee match, stored id wins, no payee), open-bills (no page cap, closed/settled dropped), linked-expense deletion |

API smoke test on **INV-202611-0016** (500,000 Ks, POSTED, UNPAID):

| Check | Result |
|---|---|
| `POST /payments` with `fundingSource = PETTY_CASH` | 400 `USE_PETTY_CASH_LINK` |
| `POST /payments` with no `fundingSource` | 400 "fundingSource is required — COMPANY_CASH or COMPANY_BANK" |
| 1,000 Ks `COMPANY_CASH` payment | 201, invoice `PARTIALLY_PAID` 2,000 with source and payer visible |
| The same payment again | 409 `DUPLICATE_PAYMENT`, naming `PY-202611-0009` |
| Re-sent with `confirmDuplicate` | 201 — a second payment row |
| `DELETE /payments/:id` with no reason | 400 "A reason is required…" |
| `DELETE` with a reason | 200, invoice back to `UNPAID` 0; the `PAYMENT_DELETED` audit entry carries the reason in `newValue` |
| Link PC-202610-0002 ("Stationery shop") to INV-202611-0016 ("Unique Myanmar") | 400 — the supplier guard refuses it |
| `GET /petty-cash/open-bills` | the one open bill, with its balance |
| `GET /payments/csv` | header includes `Funding source` and `Paid by` |

The test DB was returned to its starting state afterwards (no leftover payments; the invoice is `UNPAID` again at 0). The audit entries from the run remain — the trail is append-only.

Production was verified by health, UI 200, the applied migration and build provenance only: **no production data was written**, and the UI has not been click-through tested on either stack (verification is compile + service tests + API).

---

## 6. What is left

### Phase 2

1. `financeModuleEnabled` setting (default off, `SYSTEM_ADMIN` only) + `finance.read/manage/export` permissions.
2. `financeStatus` + hand-over / recorded + voucher fields; `RECORDED` needs voucher only (warning for uncoded lines).
3. The `RECORDED` guards P1-1 left out: refuse payment deletion / expense deletion while recorded (the placeholder comment is in `pettycash.service.ts remove()`), and the `409` that the API table already describes.
4. `Supplier.apAccountId`, `FinanceSettings`, account-coding UI.
5. GL export (accrual + payment journals) with the blocked-invoice list.

### Open / not done

- **Q-1** — does one shop payment ever cover two invoices? Until answered: one payment = one invoice.
- **UI click-through** — the P1-1/P1-2 screens have not been exercised by hand; verification so far is compile + service tests + API.

---

## 7. How to try it on testing

1. Open `http://192.168.100.110:8030` and sign in with an account that holds `payments.manage` (e.g. `finance1`). Petty-cash actions need `pettycash.manage`.
2. **Company cash / bank:** Payments → *+ Record payment* → pick a bill, choose **Paid from**, add *Paid by* and reference → Record. The invoice flips `UNPAID → PARTIALLY_PAID → PAID`, and the row shows its source and payer. The same amount twice on one day asks "record this payment again?".
3. **New float spending:** Petty Cash → *+ Record entry* → EXPENSE → amount/payee → choose *Invoice paid* → Record. The row shows `→ INV-… · PY-…`.
4. **Existing cash already spent:** Invoices → open the bill → *Link petty-cash expense*. Only unlinked expenses **paid to that supplier** are offered; a stationery-shop expense is refused against a hardware-shop bill. (In the current test data the list for INV-202611-0016 is empty for exactly that reason — the only unlinked expense belongs to another shop.)
5. **Correction:** delete the payment (Payments) or the expense (Petty Cash). A reason is required; the dialog will not confirm without one. A link's payment is removed with its expense, and the invoice returns to its previous status.

---

## 8. Rollback

- **Code:** revert to `62ef8c0` for P1-1-only, or `ef0b326` for the state before either phase. Production was backed up before this deploy: `backups/ams-prod_2026-11-27_123624.sql.gz`.
- **Schema:** additive only, so rolling the code back leaves harmless unused columns (`payments.fundingSource/payerUserId/payerName/pettyCashTransactionId`, `petty_cash_transactions.invoiceId/supplierId`). Nothing else reads them, so dropping them is optional and safe.
