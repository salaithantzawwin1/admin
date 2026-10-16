# AMS — Purchasing (စာရွက်စာတမ်း ဝယ်ယူရေး) User Manual

> **Version:** 1.0 — 2026-10-15 (codebase `5c8f0d5` နှင့် တိုက်ဆိုက်ထားသည်)
> **Scope:** Purchase Request → Approval → RFQ → Purchase Order → GRN → Invoice → Reports အဆင့်အားလုံး + Settings ထဲက Accounts / Budgets စီမံခန့်ခွဲမှု
> **Note:** UI ပေါ်က ခလုတ်/column အမည်များကို မူရင်း English အတိုင်း quote လုပ်ထားသည် — စာသားအတိုင်း ရှာနိုင်သည်။

---

## 1. ဒီ Manual ဘာအတွက်လဲ

ဝယ်ယူရေး (Purchasing) လုပ်ငန်းစဉ်ကို AMS ထဲမှာ အဆင့်ဆင့် လုပ်ဆောင်ရာတွင် အသုံးပြုသူ (requester)၊ အတည်ပြုသူ (approver)၊ ဝယ်ယူရေးတာဝန်ရှိသူ (purchasing)၊ ငွေစာရင်း/စတိုး (finance/store) တို့အတွက် လက်တွေးလမ်းညွှန်ဖြစ်သည်။

**အခြေခဃ စည်းမျဉ်း (Control):** ခွင့်ပြုချက်မရှိဘဲ မှာယူမှု (PO) မလုပ်နိုင် — "approve first, buy later"။ ဘဏ္ဍာငွေ ကျော်လွန်ပါက system က အလိုအလျောက် တားပေးသည်။

---

## 2. Roles နှင့် Permission

| ဘယ်သူ | ဘာလုပ်ရသလဲ | လိုအပ်သော permission |
|---|---|---|
| ဝယ်ယူလိုသူ (requester) | PR ရေး၊ draft သိမ်း၊ အဆင့်မြင့် submit | `requests.create` (မူလပေးထားသည်) |
| အတည်ပြုသူ (approver) | Approve / Return / Reject | `approvals.act` |
| ဝယ်ယူရေး (purchasing) | RFQ၊ Quotation၊ PO၊ GRN၊ Invoice စီမံ | `procurement.manage` |
| စာရင်းကြည့်သူ | စာရင်းများ ကြည့်ရုံ | `procurement.read` |
| Finance / Admin | Budget သတ်မှတ်၊ Account စီမံ | `procurement.manage` |

- Page အတွင်း button များက permission မရှိလျှင် မပေါ်ပါ (view ကို `procurement.read` ရှိသူတိုင်း ကြည့်နိုင်သည်)။
- ဘယ် role မှာ ဘာ permission ရှိသည်ကို sidebar ရှိ **Permissions** (`/rbac`) စာမျက်နှာမှာ စစ်နိုင်သည် (ဝင်ရန် `users.manage` လို)။

---

## 3. စာမျက်နှာ မြေပုံ

| Menu / URL | ဘာလုပ်ရသလဲ |
|---|---|
| `/procurement` (Procurement) | Purchase Request ဖန်တီးခြင်း၊ မိမိ PR များ စာရင်း |
| `/approvals` (Pending Approvals) | ခွင့်ပြုရန် စောင့်ဆိုင်းနေသော document များ |
| `/requests` (My Requests) | မိမိ တင်သွင်းထားသော document အားလုံး (Type column က PR/RFQ ခွဲပြသည်) |
| `/rfqs` (RFQ / Quotations) | Vendor များထံ ဈေးမေးခြင်း၊ quotation နှိုင်းယှဉ်ခြင်း၊ decision မှတ်ခြင်း |
| `/purchase-orders` (Purchase Orders) | PO ထုတ်ခြင်း၊ ပစ္စည်း လက်ခံရယူခြင်း (GRN) |
| `/invoices` (Invoices) | Vendor ဘေလ်များ + 3-way match |
| `/purchase-reports` (Purchase Reports / Procurement Reports) | Flow၊ vendor purchase၊ account အလိုကး အစီရင်ခံစာ၊ budget vs actual |
| `/settings?tab=accounts` (Settings → Accounts) | Chart of Accounts စီမံခန့်ခွဲခြင်း (CRUD) |
| `/settings?tab=budgets` (Settings → Budgets) | လစဉ် budget သတ်မှတ်ခြင်း |

> ⚠️ **Settings menu** ကို `users.manage` permission ရှိမှသာ sidebar မှာ မြင်ရသည် — ဝယ်ယူရေးတာဝန်ရှိသူ (purchasing) တွေ Settings မမြင်ပါက Admin ထံ Account/Budget သတ်မှတ်ရန် တောင်းဆိုပါ (သို့) URL တိုက်ရိုက်ထည့်ပြီး `procurement.manage` ဖြင့် စီမံနိုင်သည်)။

---

## 4. လုပ်ငန်းစဉ် အကျဉ်းချုပ် (Flow)

```text
Requester        Approver         Purchasing              Store / Finance
   |                |                 |                        |
   | PR ရေး + Submit|                 |                        |
   |--------------->| Approve (band   |                        |
   |                | အလိုက် အဆင့်) |                        |
   |                |---------------->| → Ask for RFQ          |
   |                |                 | Vendor invite + Quote  |
   |                |                 | Comparison + Decision  |
   |                |                 | PO ထုတ် (Account* +    |
   |                |                 |   budget check)        |
   |                |                 | Send to vendor         |
   |                |                 | 📥 Record GRN -------->| stock တက်
   |                |                 | Invoice + 3-way match  |
   |                |                 | Approve → Post -------->| စာရင်းဝင်
```

**Budget စစ်ဆေးမှု (§9)** နေရာ ၂ နေရာမှာ အလိုအလျောက် လုပ်သည် — PR submit တွင်နှင့် PO create တွင်။

---

## 5. အဆင့် ၁ — Purchase Request (PR) ရေးသားခြင်း

**လုပ်ရန်:** `/procurement` → `+ New Purchase Request` (header ရှိ button) — modal ပွင့်သည်။

### Form ထဲက အချက်များ

| Field | ဘာထည့်ရသလဲ |
|---|---|
| Items → Description * | ဝယ်ယူမည့်ပစ္စည်း/ဝန်ဆောင်မှု ဖော်ပြချက် |
| Qty * | အရေအတွက် (အနည်းဆုံး 1) |
| Unit | ယူနစ် (ချန်ထားခွင့်ရှိသည်) |
| Unit price (Ks) * | ခန့်မှန်း တစ်ခုချင်းစီဈေးနှုန်း |
| `+ Add line` | အများကြီး ထည့်နိုင်သည် — ညာဘက် `Estimated total` အလိုအလျောက် တွက်ပေးသည် |
| Priority | `Normal` / `Urgent` |
| Required date (optional) | လိုအပ်သည့်ရက် |
| Budget code (optional) | ဌာနတွင်း ငွေကြေးကုဒ် (ရှိပါက) |
| Purpose / justification (optional) | ဘာကြောင့် ဝယ်ရသည် |

> ⚠️ **Account / Asset ကို PR form မှာ မထည့်တော့ပါ** (2026-10-14 မှစ) — ဝယ်ယူရေးအဆင့် (PO) မှသာ Account သတ်မှတ်သည်။ Requester ဘက်က သူတို့သိတဲ့ အချက်တွေ (ဖော်ပြချက်/အရေအတွက်/ဈေးနှုန်း) သာ ရေးရသည်။

### သိမ်းရန် နည်းလမ်း ၂ ခု

- **`Save as Draft`** — DRAFT အဖြစ် သိမ်း (နောက်မှ ပြင်နိုင်သည်၊ ခွင့်ပြုချက် မတောင်းသေး)
- **`Submit for Approval`** — ခွင့်ပြုရန် ပို့ (ပို့ပြီး ပြင်၍မရ — cancel ပြန်ရသည်)

### Budget တားခံရပါက (BUDGET_EXCEEDED)

Submit ချိန်တွင် ထို PR ရဲ့ စုစုပေါင်းခန့်မှန်းငွေက အဆင့်မြင့် အကောင့်တစ်ခုရဲ့ လက်ကျန် budget ကျော်လွန်ပါက **modal ပေါ်လာပြီး ရပ်သွားသည်** (row မရေးပါ)။ Modal ထဲမှာ ဘယ် account ဘယ်လောက် ကျော်နေသည် ပါသည်။

- **ဖြေရှင်းနည်း:** ပမာဏ လျှော့ပါ / အခြား account ပြောင်း (PO အဆင့်မှာ ရွေးရမည်) / Finance ထံ budget တိုးခိုင်းပါ / budget မသတ်မှတ်ထားသော account သုံးပါ (budget မရှိသူကို မတားပါ)။

### PR ရဲ့ Status များ

| Status | အဓိပ္ပာယ် |
|---|---|
| `DRAFT` | သိမ်းထားသေးသည် — ပြင်နိုင်သေးသည် |
| `PENDING_APPROVAL` | အတည်ပြုသူ စောင့်ဆိုင်းနေသည် |
| `APPROVED` | အတည်ပြုပြီး — RFQ / PO ဆက်လုပ်နိုင် |
| `RETURNED` | ပြန်လွှင့်ခံရ (comment နှင့်အတူ — ပြင်ပြီး ပြန် submit လုပ်ပါ) |
| `REJECTED` | ငြင်းပယ်ခံရ |
| `CANCELLED` | ဖျက်သိမ်းပြီး |

---

## 6. အဆင့် ၂ — ခွင့်ပြုခြင်း (Approvals)

**လုပ်ရန်:** `/approvals` (Pending Approvals) — ကိုယ့်အဆင့်ရောက်နေသော document များ စာရင်းပေါ်သည်။

- **`Approve`** — အတည်ပြု
- **`Return`** — တင်သွင်းသူထံ ပြန်လွှင့် (ပြင်ဆင်ပြီး ပြန် submit လုပ်ရ)
- **`Reject`** — ငြင်းပယ် (`Comment (required for reject)` — comment မပါမရ)
- `Cancel Request` — တင်သွင်းသူဘက်က ပြန်လည် ရုပ်သိမ်းခြင်း

**Amount band (ပမာဏအလိုက် အဆင့်) — ဥပမာ seed data:**

| Estimated total | အဆင့် |
|---|---|
| ≤ 500,000 Ks | Department Head |
| ≤ 2,000,000 Ks | + Administration |
| ≤ 10,000,000 Ks | + Finance |
| > 10,000,000 Ks | + Management |

> Band များကို Settings → Approval Workflows မှာ company policy အလိုက် ပြင်နိုင်သည် (code မပြောင်းရ)။

---

## 7. အဆင့် ၃ — RFQ (ဈေးမေးခြင်း) နှင့် Vendor ရွေးချယ်ခြင်း

**လုပ်ရန်:** `/procurement` မှာ APPROVED ဖြစ်နေသော PR ကြောင့် **`→ Ask for RFQ`** ကို နှိပ်ပါ (သို့) `/rfqs` → `+ New RFQ`။

အဆင့်များ:

1. **RFQ ဖန်တီး** — title, specification, `Quotation due date (§11)` (quotation ပေးရန် ရက်)၊ `Vendors to invite (§11)` ထဲက select မှ vendor များ ရွေး (`Invite a vendor…` — vendor တစ်ဦးတည်း တစ်ကြိမ်သာ ဖိတ်ရသည်)
2. **`+ Record quotation`** — vendor တစ်ဦးချင်းစီရဲ့ quote number, date, valid until, payment terms + item တွေဈေးနှုန်း (tax/discount, delivery days, warranty ထည့်နိုင်)။ **တစ်ဦးတည်း တစ်ကြိမ်သာ** သိမ်းရသည်။
3. **Comparison** — စာမျက်နှာက ဈေးနည်းနည်းမှ များများအထိ စီပြပေးသည် (net totals low → high)
4. **Vendor decision (§14)** — ဘယ် vendor ကို ရွေးသည် + ရွေးချယ်မှုအကြောင်းပြချက် (မဖြစ်မနေ) — justification မပါဘဲ မရပါ။

---

## 8. အဆင့် ၄ — Purchase Order (PO) ထုတ်ခြင်း

**လုပ်ရန်:** `/purchase-orders` → `+ New purchase order`

**ထည့်ရန်အချက်များ:**

| Field | မှတ်ချက် |
|---|---|
| Supplier * | vendor ရွေး |
| From approved PR (optional) | ရွေးပါက PR က line items များ အလိုအလျောက် ဖြည့်ပေးသည် — **PR က APPROVED ဖြစ်ရမည်** (Control 1: no approval, no PO) |
| (ဗလာထားပါက) | ad-hoc / direct purchase — PR မလိုဘဲ တိုက်ရိုက်ဝယ်ခြင်း |
| Expected delivery | မျှော်မှန်းရက် |
| Inventory item (optional) | 📦 stock ပစ္စည်းဆိုရင် ရွေး — GRN မှာ stock အလိုအလျောက်တက်မည် |
| Description * / Qty * / Unit / Unit price (Ks) * | line တစ်ကြောင်းချင်းစီ |
| **Account * ** | **မဖြစ်မနေ** — ဘယ် account ကို ငွေဖိုး တင်သည်ကို ရွေး (PO form မှာသာ — PR form မှာ မဟုတ်) |

**Budget စစ်ဆေးမှု:** Account တစ်ခုချင်းစီ စုစုပေါင်းက လက်ရှိလ/နှစ် budget လက်ကျန်နှင့် နှိုင်းယှဉ်စစ်သည် — ကျော်လွန်ပါက **409 `BUDGET_EXCEEDED`** modal (BudgetBlockedModal) ပေါ်ပြီး PO မဖြစ်မနေ မရေးပါ။

**PO ရဲ့ Status များ (§16):**

| Status | ဘယ်အချိန်ဖြစ်သလဲ |
|---|---|
| `DRAFT` | ဖန်တီးပြီးစ (approve မလုပ်ရသေး) |
| `APPROVED` | အတည်ပြုပြီး |
| `SENT_TO_VENDOR` | `Send to vendor` နှိပ်ပြီး (vendor ဆီ ပို့ပြီး) |
| `PARTIALLY_RECEIVED` | GRN အချို့သာ ရောက် (တစ်စိတ်တစ်ပိုင်း) |
| `FULLY_RECEIVED` | အားလုံး လက်ခံပြီး |
| `CLOSED` | `Close PO` — ပိတ်ပြီး (အပြည့်အစုံ မရောက်မချင်း မပိတ်ရ) |
| `CANCELLED` | `Cancel PO` |

**PO အဆင့် button များ:** `Approve` → `Send to vendor` → `📥 Record GRN` → `Close PO` / `Cancel PO`

---

## 9. အဆင့် ၅ — GRN (ပစ္စည်း လက်ခံရယူခြင်း)

**လုပ်ရန်:** PO detail ထဲ → `📥 Record GRN`

| Field | သတိပြုရန် |
|---|---|
| Received * | အမှန်တကယ် ရောက်သော အရေအတွက် |
| Accepted | လက်ခံမည့် အရေအတွက် — **ordered ထက် မကျော်ရ** (over-receiving guard) |
| Rejected | ပြန်ပို့မည့် အရေအတွက် (condition note ဖြင့်) |
| Condition | အခြေအနေ မှတ်ချက် |

- **`Record GRN & post stock`** နှိပ်ပါက:**📦 inventory line များ** ရဲ့ accepted ပမာဏက ရှိပြီးသား **StockTransaction ledger** ထဲ တန်းတက်သည် (စတိုး စာရင်းနှင့် ကွဲပြားသော ledger ထပ်မလုပ်ပါ)။
- တစ်စိတ်တစ်ပိုင်း ရောက်ပါက GRN အကြိမ်များစွာ သုံးနိုင် — PO status က `PARTIALLY_RECEIVED` → `FULLY_RECEIVED` ပြောင်းသည်။
- အားလုံး မရောက်မချင်း `Close PO` မလုပ်ရ။

---

## 10. အဆင့် ၆ — Invoice (Vendor ဘေလ်) + 3-way Match

**လုပ်ရန်:** `/invoices` → `+ New invoice`

- PO ရွေးပါက line များ pre-fill ဝင်သည် — vendor ဘေလ်နံပါတ်၊ subtotal/tax/total ထည့်
- **`Save as Draft`** — DRAFT သိမ်း (အရင် စစ်ဆေးချင်ပါက)
- **`Create & Submit (runs 3-way match)`** — ဖန်တီးပြီး တိုက်ရိုက် submit (3-way match ပြုလုပ်သည်)

**3-way match status (§23) — line တိုင်း/ဘေလ် အတွက်:**

| Status | အဓိပ္ပာယ် |
|---|---|
| `MATCHED` | GRN accepted နှင့် အညီ — အပြည့်အစုံ ကိုက် |
| `PARTIAL_MATCH` | အချို့ကိုက်/ဆက်လက် ရောက်နေသေးသည် |
| `MISMATCH` | GRN ထက် ပိုတောင်း / ဈေးကွာ / PO ပမာဏ ကျော် — **approve မရ** |
| `NO_MATCH` | PO မပါဘဲ ရောက်သော ဘေလ် |

**Control များ (system က အလိုအလျောက် တားသည်):**

- **Control 3:** GRN မရှိဘဲ PO ကြိုတင်ပြီး ဘေလ် submit မရ — deliver မဖြစ်မချင်း ဘေလ်မထားရ
- **Control 4:** ဘေလ်စုစုပေါင်း PO ထက် ကျော်ပါက hold ခံရ
- **Control 5:** vendor + invoice no. တူသော ဘေလ် ထပ်ထည့်၍မရ (duplicate bill)

**Invoice status:** `DRAFT` → `SUBMITTED` → `APPROVED` → `POSTED` (+ `REJECTED`)

Detail စာမျက်နှာ button အလိုက်:

| Status | Button |
|---|---|
| `SUBMITTED` | `Approve` / `Reject` (match `MATCHED`/`PARTIAL_MATCH` ဖြစ်မှ approve ရ) |
| `APPROVED` | `Post` (စာရင်းဝင်ရန်) / `Cancel` |

---

## 11. Settings — Chart of Accounts (Account စီမံခြင်း)

**လုပ်ရန်:** `/settings?tab=accounts` (Settings → Accounts tab) — `procurement.manage` ရှိမှ ရေးလို့ရသည်

- **`+ New account`** — Code (optional, unique)၊ Name *၊ Category (Expense/Consumable/Asset/Liability/Income)၊ Active
- **`Edit`** — အမည်/code/category ပြင်
- **`Deactivate` / `Activate`** — **ရုပ်သိမ်းရန် နည်းမှန်** — inactive ဖြစ်သွားလျှင် PO/invoice/budget picker တွေမှာ မပေါ်တော့ပါ၊ စာရွက်ဟောင်းတွေမှာ reference ကတော့ ကျန်သည်
- **`Delete`** — account ကို PR/PO/invoice line သို့ budget က သုံးထားပြီးဆိုပါက **409 "…is used by … — deactivate it instead"** ဖြင့် တားပြီး ဖျက်၍မရ (audit ချိုးဖျက်မှု ကာကွယ်ရန်)။ ဘယ်တော့မှ မသုံးဖူးသော account ကိုသာ delete ရသည်။

> Code ထပ်သွားပါက `409 already exists` — ကွဲပြားအောင် ပြင်ပါ။

---

## 12. Settings — Monthly Budgets

**လုပ်ရန်:** `/settings?tab=budgets`

1. Year / Month ရွေး → Account ရွေး → Amount (Ks) ထည့် → **`Save budget`**
2. ဇယားထဲမှာ Budget / Spent / Remaining / Used % ပေါ်သည် (Spent က APPROVED/POSTED invoice line တွေက တိုက်ရိုက်တွက်သည်)
3. **`⬇ CSV`** — Excel export
4. **Filter by account** — ရှာဖွေရန်

**စည်းမျဉ်း:** budget မသတ်မှတ်ထားသော account ကို **မတားပါ** (Finance က သတ်မှတ်ပြီးမှသာ enforce ဖြစ်သည်)။ Used % က `100%` ရောက်ပါက submit/PO တားခံရမည်။

---

## 13. Reports (Procurement Reports)

**`/purchase-reports`** — အားလုံး အမှန်တကယ် စာရင်း data ပေါ်တွင်:

- **Flow tiles** — PR/PO/GRN/Invoice အဆင့်အလိုက် အရေအတွက် + 3-way match badge များ
- **Vendor purchase report** — vendor တစ်ဦးချင်းစီ ဝယ်ယူမှု (date range filter)
- **Purchase by account** — ဘယ် account ကို ဘယ်လောက် သုံးထားသလဲ
- **Budget vs actual** — လ/နှစ် ရွေးပြီး budget နှင့် အသုံးစရိတ် နှိုင်းယှဉ်

---

## 14. Status အပြည့်အစုံ စာရင်း (Glossary)

| Document | Status များ |
|---|---|
| Purchase Request | `DRAFT` → `PENDING_APPROVAL` → `APPROVED` / `RETURNED` / `REJECTED` / `CANCELLED` |
| PO | `DRAFT` → `APPROVED` → `SENT_TO_VENDOR` → `PARTIALLY_RECEIVED` → `FULLY_RECEIVED` → `CLOSED` (+ `CANCELLED`) |
| Invoice | `DRAFT` → `SUBMITTED` → `APPROVED` → `POSTED` (+ `REJECTED`) |
| Match | `MATCHED` / `PARTIAL_MATCH` / `MISMATCH` / `NO_MATCH` |

---

## 15. မကြာခဏ မေးလေ့ရှိသော မေးခွန်းများ (FAQ / Troubleshooting)

**Q: PR submit လိုက်တာနဲ့ "Budget check (§9) … resolve the … budget first" ဆိုပြီး တားခံရတယ်။**
A: ထို account ရဲ့ လက်ရှိလ budget လက်ကျန်ထက် ခန့်မှန်းငွေ ကျော်နေလို့။ modal ထဲက account/ပမာဏ ကြည့်ပြီး — ပမာဏလျှော့/ရက်ရွှေ့/Finance ထံ budget တိုး/ budget မရှိသေးသော account ပြောင်းပါ။

**Q: PO တွင် Account dropdown ဘာကြောင့် မဖြည့်ရသလဲ (ဘာကြောင့် မရသလဲ)?**
A: Account * မှာ **မဖြစ်မနေ ရွေးရမည်** — ဘယ် account ကို ငွေဖိုးတင်သည်ကို system သိရန်။ Account စာရင်းမရှိရင် Settings → Accounts မှာ `+ New account` နဲ့ ထည့် (permission လိုသည်)။

**Q: Account ကို delete ခလုတ်နှိပ်တော့ "is used by … deactivate instead" ပြတယ်။**
A: ထို account ကို စာရွက်/budget တွေက သုံးထားပြီး — audit အတွက် မဖျက်ရပါ။ **`Deactivate`** နှိပ်ပါ (picker တွေကနေ ပျောက်သွားမယ်)။

**Q: "no workflow" / workflow မတွေ့ဘူး ဆိုတဲ့ error ပေါ်တယ်။**
A: ထို document type အတွက် active approval workflow မရှိသေး — Admin ထံ အကြောင်းကြားပြီး Settings → Approval Workflows မှာ ဖန်တီးခိုင်းပါ။

**Q: PO လုပ်ချင်ပေမယ့် PR က APPROVED မဖြစ်သေးဘူး (Control 1)။**
A: အတည်ပြုချက်မရဘဲ PO မရပါ — PR ကို approve စေပါ (သို့) ad-hoc direct purchase အနေဖြင့် PR မပါဘဲ PO ဖန်တီးနိုင်သည်၊ သို့သော် budget check ကတော့ အမြဲ လျှောက်သည်။

**Q: Invoice approve လို့မရဘူး။**
A: match status က `MISMATCH` သို့ `NO_MATCH` ဖြစ်နေလို့ — GRN အရေအတွက်/ဈေးနှုန်း မကိုက်ဘူး။ GRN ပြင်/PO ပမာဏ စစ်ပြီးမှ ပြန်တင်ပါ (Control 3/4/5 ကလည်း hold လုပ်နိုင်သည် — message ကို ဖတ်ပါ)။

**Q: Button တွေ မပေါ်ဘူး။**
A: `procurement.manage` permission မရှိ — ကိုယ့် role အတွက် `procurement.read` ပဲ ရှိနိုင်သည်။ Admin ထံ တောင်းဆိုပါ (sidebar ရှိ **Permissions** `/rbac` စာမျက်နှာမှာ ကြည့်နိုင်သည်)။

**Q: Draft PR ကို ပြင်ချင်တယ်။**
A: `DRAFT` ဆိုရင် ပြင်နိုင်သည် — submit ပြီးသွားရင် `Cancel Request` ပြီးမှ အသစ်ပြန်ရေးရသည် (approval history မပျက်အောင် ဒီလိုပဲ လုပ်ထားသည်)။

---

## 16. အမှားပြင်ဆင်မှု မှတ်တမ်း (Changelog)

| ရက် | ပြောင်းလဲမှု |
|---|---|
| 2026-10-14 | Account/Asset ကို PR form မှ PO form သို့ ပြောင်း (PO တွင် Account * မဖြစ်မနေ) |
| 2026-10-15 | Settings → Accounts tab (Chart of Accounts CRUD) ထည့်; `?all` flag ပြောင်းပြန်မှု fix (inactive account များ picker တွေမှာ မပေါ်တော့) |
