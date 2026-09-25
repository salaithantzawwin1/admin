# Plan — Telegram `/car` Request Flow (Phase 2)

**Goal:** a requester who is out of the office creates and submits a car
request entirely inside Telegram — no VPN, no office WiFi, no browser.
After submission the existing chain takes over unchanged: approval buttons →
`/assign` picker → driver ack stages → Back at Office.

**Status:** plan only — not yet implemented. Estimate: 1–2 working days.

**Design decision (revised after review):** the request arrives as **ONE form
card showing every field at once** — not six one-question-at-a-time prompts.
The user fills it by replying with the field name and value (or edits the
previous message). One message = one place to look = fast for users who know
what they need, and the card itself documents the expected format.

---

## 1. What already exists (reuse, don't rebuild)

| Building block | Where | Reuse for /car |
|---|---|---|
| Slash-command hook | `TelegramService.commands` (wired by `TelegramCarActionsService.wire()`) | register `/car` + `/cancel` handlers |
| Text-conversation state machine | `pendingRejects` Map + TTL + `/cancel` + supersede rules | same pattern for `pendingCarRequests` |
| Service-layer creation + validation | `CarsService.createCarRequest()` (dates, 17:00 default end, doc number, audit) | call it directly — bot never writes Prisma itself |
| Submission | `WorkflowService.submit()` (guard: requester only, DRAFT only) | submit right after create, as the same actor |
| Bound-user resolution | `TelegramCarActionsService.boundUser(chatId)` | identify the requester |
| Permission gating | `PermissionsService.forUser()` | authenticated bound user is enough |
| Clash warning | `CarsService` availability/conflicts logic (used by web form) | pre-submit double-booking hint |
| Confirmation card + Open in AMS | `sendRaw` + `webUrl` deep link | final summary card with doc number |

## 2. Conversation design — one form card (bilingual labels)

**Language:** labels are **Burmese-first with English field keys** — users
reply with either the Burmese or the English key (both accepted, case-
insensitive). This matches how the workforce actually types.

**Field list (9 — the 7 planned + Vehicle type + Notes):**

| # | English key (aliases) | Burmese label | Required | Default | Notes |
|---|---|---|---|---|---|
| 1 | `Destination` (dest, သွားမယ့်နေရာ) | သွားမယ့်နေရာ | ✅ | — | free text, 2–200 chars |
| 2 | `Start` (start time, ထွက်ချိန်) | ထွက်မယ့်အချိန် | ✅ | — | `YYYY-MM-DD HH:MM` Yangon; `HHMM` also OK |
| 3 | `Slot` (time slot, အချိန်အပိုင်း) | အချိန်အပိုင်းအခြား | — | Full day | tap buttons or text: Full day / Half AM / Half PM / Custom |
| 4 | `End` (end time, ပြန်ချိန်) | ပြန်ရောက်မည့်အချိန် | Custom မှာ ✅ | same-day 17:00 | only asked/needed for Custom |
| 5 | `Passengers` (pax, လိုက်သူ) | လိုက်ပါသူ | — | 1 | 1–60 |
| 6 | `Vehicle` (vehicle type, ကားအမျိုးအစား) | ကားအမျိုးအစား | — | — | SEDAN / SUV / PICKUP / VAN / BUS / STAFF_BUS … (web list); text match, `/skip` clears |
| 7 | `Pickup` (pickup location, တက်မည့်နေရာ) | တက်မည့်နေရာ | — | — | `-` = omit |
| 8 | `Purpose` (purpose, ရည်ရွယ်ချက်) | ရည်ရွယ်ချက် | — | — | `-` = omit |
| 9 | `Notes` (description, မှတ်ချက်) | မှတ်ချက် | — | — | free text → description column |

```
User: /car
Bot:  🚗 ကားတောင်းခံလိုက်ပါသည် — New car request
      ────────────────────────────
      အောက်ပါအတိုင်း ဖြေဆိုပါ (အစီအစဉ်မှန်ရုံပဲ — တစ်ခါတည်းရေးလည်းရ):

      သွားမယ့်နေရာ (Destination): —
      ထွက်မယ့်အချိန် (Start): —            ဥပမာ 2026-09-28 08:30
      အချိန်အပိုင်းအခြား (Slot): Full day  [☀️ Full day] [🌅 Half AM] [🌆 Half PM] [⏱ Custom]
      လိုက်ပါသူ (Passengers): 1
      ကားအမျိုးအစား (Vehicle): —          ဥပမာ SUV, VAN, STAFF_BUS (/skip = ဘာမှမထည့်)
      တက်မည့်နေရာ (Pickup): —            (/skip = မထည့်)
      ရည်ရွယ်ချက် (Purpose): —           (/skip = မထည့်)
      မှတ်ချက် (Notes): —                 (/skip = မထည့်)

      ✅ ပြည့်စုံပါက Submit နှိပ်ပါ — /cancel ဖြင့် ပယ်ဖျက်နိုင်သည်။
User: သွားမယ့်နေရာ: မန္တလေး လုပ်ငန်းသွားရေး
      ထွက်မယ့်အချိန်: 2026-09-28 08:30
      လိုက်ပါသူ: 3
      ကားအမျိုးအစား: VAN
      တက်မည့်နေရာ: ရုံးချုပ်
Bot:  📋 လက်ရှိဖြည့်ထားမှု —
      ✅ သွားမယ့်နေရာ: မန္တလေး လုပ်ငန်းသွားရေး
      ✅ ထွက်မယ့်အချိန်: တနင်္ဂနွေ 2026-09-28 08:30
      အချိန်အပိုင်းအခြား: Full day (ပြန်ရောက် 17:00 အလိုအလျောက်)
      ✅ လိုက်ပါသူ: 3
      ✅ ကားအမျိုးအစား: VAN
      ✅ တက်မည့်နေရာ: ရုံးချုပ်
      ➖ ရည်ရွယ်ချက်: —
      ➖ မှတ်ချက်: —
      + ⚠️ ဤအချိန်အတွင်း ကားချုပ်မှုရှိပါက သတိပေးစာ
      [✅ Submit] [❌ Cancel]                    ← inline buttons (re-shown)
User: taps ✅ Submit
Bot:  → CarsService.createCarRequest(...) as the bound user
      → WorkflowService.submit(...)
Bot:  ✅ တောင်းခံလိုက်ပါပြီ — CAR-202609-0042 — ခွင့်ပြုချက် စောင့်နေပါသည်။
      [Open in AMS]
      → approvers receive the existing [✅ Approve][❌ Reject] card
```

Rules:
- **The user may answer all fields in one reply or several** — each reply is
  parsed line-by-line (`key: value`, Burmese or English key, fuzzy-matched),
  updating whatever it names. Unknown keys get a gentle re-echo of the field
  list, not an abort. A bare text line with no `key:` and NO open /car
  conversation anywhere else is ignored; inside the conversation it asks the
  user to prefix the field name.
- After every reply the bot re-renders the current-values card (✅ filled /
  ➖ empty / ❌ invalid) and re-shows [✅ Submit][❌ Cancel].
- Required before Submit: **Destination + Start** (+ End when Slot=Custom).
  Missing/invalid ones render ❌ in the card — Submit with them missing is
  rejected with the card re-shown, not a separate nag message.
- `/cancel` aborts and clears state (supersedes an armed reject conversation,
  same as approve already does). `/skip` clears the immediately-preceding
  optional field when used as its value.
- Date parsing: accept `YYYY-MM-DD HH:MM` and `YYYY-MM-DD HHMM`; garbage →
  field rendered ❌, never guessed.
- Vehicle type: case-insensitive fuzzy match against the web list (SEDAN,
  SUV, PICKUP, VAN, BUS, TRUCK, OTHER, MINIVAN, MINIBUS, LIMOUSINE,
  STAFF_BUS, VAN_CARGO); no match → ❌ with the valid list echoed.
- State TTL 15 min, cap 200 chats, sweep on arm (same as REJECT_TTL_MS).

## 3. Implementation steps

1. **State** — `pendingCarRequests: Map<chatId, { draft, at }>` in
   `TelegramCarActionsService` (`draft` = plain object of the 7 fields; no
   step counter needed — the form is stateless between replies).
2. **Handlers** — `handleCarCommand(text, chatId)` returns true for `/car`
   and renders the form card; `handleCarText(text, chatId)` parses
   `Field: value` lines; callbacks `wfa:slot:<SLOT>` / `wfa:carsubmit` /
   `wfa:carcancel` wired into `handleCallback`'s token switch.
3. **Ordering** — in `TelegramService.handleUpdate`, the armed-conversation
   check runs BEFORE the slash-command fallback (mirrors the rejects hook),
   so `/cancel`, `Done` and field replies are consumed while open.
4. **Submit path** — validate Destination+Start → build the exact payload the
   web DTO expects → `CarsService.createCarRequest(payload, boundUser as
   actor)` → `WorkflowService.submit(request.id, same actor)` → success card
   with doc number + Open-in-AMS. Validation errors (bad date, no workflow)
   are echoed on the card and the conversation stays open for fixing.
5. **Gates** — unlinked chat → "not linked" error; `telegram.enabled` false →
   flow never starts (bot-wide gate already handles it).
6. **Registration** — wire in `CarsModule.onApplicationBootstrap` next to the
   existing hooks; add `/car — request a vehicle` to the bot's command list.

## 4. Testing

- **Unit (test/telegram-car-request.test.ts)** — renders bilingual card on
  /car; one-reply-all-fields parsing; Burmese AND English key matching;
  multiple replies accumulate; unknown key re-echo; bad date rendered ❌ not
  guessed; slot free-text + callback paths; vehicle fuzzy match + invalid
  echo; missing-required blocks Submit with ❌ fields; `/cancel` clears;
  `/skip` semantics; TTL expiry; unlinked chat; supersede: opening /car while
  a reject conversation is armed. Harness style: mock prisma + spy `call()`,
  same as telegram-assign-e2e.
- **E2E on testing stack (scripts/server/verify-tg-car-request.sh)** — real
  bound user drives /car via the bot API against :3011, asserts the doc
  number arrives and the request lands as PENDING_APPROVAL with the correct
  window.

## 5. Out of scope (deliberate)

- Editing/cancelling requests from Telegram (web UI remains the place).
- Free-text Burmese NLP — only the field KEY is matched bilingually; VALUES
  (destination, purpose, notes) are stored exactly as typed.
- Meeting-room / supply / travel requests via bot (same pattern later).
- Telegram Mini App (web form inside Telegram) — bigger change, separate plan.
- Photos/attachments on the request.
