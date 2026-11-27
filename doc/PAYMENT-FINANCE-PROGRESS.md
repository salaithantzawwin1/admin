# Payment & Finance — Progress Record

**Last updated:** 27 Nov 2026
**Requirements:** `doc/AMS-Payment-Finance-Requirements-v2.md` (approved)
**Environment:** implemented and verified on **TESTING only** (`http://192.168.100.110:8030`, API `127.0.0.1:3011`). Production (`:80`) has **not** been rebuilt or migrated.

---

## 1. Where the project stands

| Phase | Scope | State |
|---|---|---|
| **P1-1** | Petty-cash expense ↔ invoice link + auto payment, cancel/reject guard, advisory float | ✅ **Done, deployed to testing, verified by API** |
| **P1-2** | Company cash / bank payments (`+ Record payment`), relaxed status guard, payments-page columns, duplicate prompt | ⏳ Not started |
| **Phase 2** | `financeModuleEnabled` toggle, `financeStatus` + voucher, `finance.*` RBAC, `Supplier.apAccountId`, `FinanceSettings`, GL export + blocked list | ⏳ Not started |
| **Phase 3** | Float reconciliation, company-cash tracking, multi-invoice payments, refunds | ⏳ Not decided |

---

## 2. P1-1 — what was built

### Schema (additive, migration `00000000000093_petty_cash_invoice_link`)

- `petty_cash_transactions.invoiceId`, `.supplierId` (+ FKs, indexes)
- `payments.fundingSource`, `.payerUserId`, `.payerName`, `.pettyCashTransactionId` **UNIQUE** (+ FK, index)

No column renamed, no row deleted, no enum changed. Existing rows keep `NULL` (no guessed links).

### Backend

| File | Change |
|---|---|
| `src/procurement/payment-rollup.ts` (new) | `syncInvoiceRollup(tx, invoiceId)` + `PAYMENT_TOLERANCE` — the one writer of `paidAmount`/`paymentStatus`, shared by both write paths |
| `src/pettycash/pettycash.service.ts` | Expense accepts `invoiceId`: validates the bill (not cancelled/rejected, has a balance, amount ≤ balance), then writes **expense + payment + rollup in one transaction**. `linkInvoice()` links an existing expense. `linkable()` feeds the picker. `remove()` deletes the payment with the expense and re-rolls the invoice, with two audit entries. TOPUP can never be linked |
| `src/pettycash/pettycash.controller.ts` | `POST /petty-cash` accepts `invoiceId`; new `POST /petty-cash/:id/link-invoice`, `GET /petty-cash/linkable/:invoiceId` |
| `src/procurement/payments.service.ts` | Uses the shared rollup; `DELETE /payments/:id` refuses a `PETTY_CASH` payment (409 — delete the expense instead) |
| `src/procurement/invoices.service.ts` | Cancel/reject refused (409) while `paidAmount > 0` (BR-14); `GET /invoices/:id` returns `payments[]` and `pettyCashExpenses[]` |

Payment rows created by the link: `fundingSource = PETTY_CASH`, `method = CASH`, `date` = expense date, `reference` = expense code, `pettyCashTransactionId` = the expense.

### Frontend

| Screen | Change |
|---|---|
| Petty Cash | Expense form has an optional **Invoice paid** picker (open bills with a balance, shows outstanding); picking one pre-fills the payee; saving is blocked only when the amount exceeds the invoice balance, not the float. Ledger rows show `→ INV-… · PY-…`. Delete dialog explains that the payment goes with it |
| Invoice detail | **Payment to supplier** panel: paid / outstanding, payment list (source, method, note), and **Link petty-cash expense** with the unlinked-expense picker |

### Verification (testing stack)

Typecheck: backend `tsc --noEmit` ✅, frontend `tsc -b` ✅. Containers healthy, migration applied, routes mapped, health 200.

API smoke test on **INV-202611-0016** (500,000 Ks, POSTED, UNPAID):

| Check | Result |
|---|---|
| TOPUP with an invoice | 400 "a top-up is not a payment" |
| Expense 600,000 against a 500,000 balance | 400 over-payment |
| Expense 500,000 linked | 201 → invoice **PAID**, 1 payment, `PETTY_CASH`, expense linked |
| `DELETE /payments/:id` on that payment | 409 "delete that expense instead" |
| Delete the expense | 200 → invoice back to **UNPAID**, 0 payments |
| Link an existing unlinked expense (backfill) | 201 → PAID; linking it twice → 409 |
| Reject a paid invoice (throwaway SUBMITTED invoice) | 409 "has 100 MMK recorded as paid" → after removing the payment → 201 REJECTED |

The test DB was returned to its starting state afterwards (no leftover rows).

---

## 3. What is left

### P1-2 (next)

1. `POST /payments`: accept `fundingSource` (`COMPANY_CASH` / `COMPANY_BANK`), reject `PETTY_CASH` with `400 USE_PETTY_CASH_LINK`, accept payer, relax the status guard to "not CANCELLED/REJECTED" (BR-3/D-11).
2. Invoice detail: **+ Record payment** modal (source, amount, date, payer, reference).
3. Payments page: funding-source and payer columns; CSV updated.
4. Duplicate confirmation prompt (BR-15).
5. Make `fundingSource` mandatory on new payments once the modal exists (BR-7).

### Phase 2

1. `financeModuleEnabled` setting (default off, `SYSTEM_ADMIN` only) + `finance.read/manage/export` permissions.
2. `financeStatus` + hand-over / recorded + voucher fields; `RECORDED` needs voucher only (warning for uncoded lines).
3. `RECORDED` guards that P1-1 deliberately left out: refuse payment deletion / expense deletion while recorded (the code has the placeholder comment in `pettycash.service.ts remove()`).
4. `Supplier.apAccountId`, `FinanceSettings`, account-coding UI.
5. GL export (accrual + payment journals) with the blocked-invoice list.

### Open / not done

- **Q-1** — does one shop payment ever cover two invoices? Until answered: one payment = one invoice.
- **Production deploy** — not authorised yet. Needs the same rebuild + `prisma migrate deploy` on the `ams` project (`compose.prod.yaml`, `:80`).
- **UI click-through** — the P1-1 screens have not been exercised by hand yet; verification so far is compile + API.

---

## 4. How to try P1-1 on testing

1. Open `http://192.168.100.110:8030` and sign in with an account that holds `pettycash.manage` (or SYSTEM_ADMIN).
2. **Existing cash already spent:** Invoices → open INV-202611-0016 → *Link petty-cash expense* → pick the expense → the bill turns **PAID**, the panel shows the payment with source *Petty cash*.
3. **New spending:** Petty Cash → *+ Record entry* → EXPENSE → fill amount/payee → choose *Invoice paid* → Record. The row shows `→ INV-… · PY-…`.
4. **Correction:** Petty Cash → Delete that expense → the bill returns to its previous status. Both deletions are in the audit log.

---

## 5. Rollback

- Code: revert the P1-1 commit; the previous image can be rebuilt from `ef0b326`.
- Schema: additive only, so rolling back the code leaves harmless unused columns. Dropping them is optional and safe (nothing else reads them).
