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

## 2. Conversation design — one form card

```
User: /car
Bot:  🚗 New car request
      ────────────────────────────
      Reply with the values (any order, one per line):

      Destination: 
      Start:          2026-09-28 08:30   (Yangon, YYYY-MM-DD HH:MM)
      Slot:           Full day | Half AM | Half PM | Custom
      End:            (Custom only — else auto 17:00)
      Passengers:     1
      Pickup:         (optional — reply "Pickup: -" to omit)
      Purpose:        (optional — reply "Purpose: -" to omit)

      ✅ Reply "Done" to submit when finished.
      /cancel aborts.
User: Destination: Mandalay site visit
      Start: 2026-09-28 08:30
      Passengers: 3
      Pickup: Head Office
Bot:  📋 Current values —
      Destination: Mandalay site visit
      Start: Sun 2026-09-28 08:30
      Slot: Full day (End 17:00 auto)
      Passengers: 3
      Pickup: Head Office
      Purpose: —
      + ⚠️ clash hint if another booking overlaps this window
      [✅ Submit] [❌ Cancel]                    ← inline buttons (re-shown)
User: taps ✅ Submit
Bot:  → CarsService.createCarRequest(...) as the bound user
      → WorkflowService.submit(...)
Bot:  ✅ Submitted as CAR-202609-0042 — waiting for approval.
      [Open in AMS]
      → approvers receive the existing [✅ Approve][❌ Reject] card
```

Rules:
- **The user may answer all fields in one reply or several** — each reply is
  parsed line-by-line (`Field: value`), updating whatever it names. Unknown
  field names get a gentle re-echo of the field list, not an abort.
- After every reply the bot re-renders the current-values card and re-shows
  [✅ Submit][❌ Cancel] — the user always sees the live state.
- Required before Submit: **Destination + Start** (both validated).
  Missing ones are highlighted in the card (❌ Destination) instead of
  prompting one by one.
- `/cancel` aborts and clears state (supersedes an armed reject conversation,
  same as approve already does).
- Slot via free text (`Slot: half am`) OR by tapping a slot row rendered as a
  small inline keyboard on the card (`wfa:slot:<SLOT>` callback) — both paths
  set the same field.
- Date parsing: accept `YYYY-MM-DD HH:MM` and `YYYY-MM-DD HHMM`; garbage →
  field highlighted red in the re-render, never guessed.
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

- **Unit (test/telegram-car-request.test.ts)** — renders form card on /car;
  one-reply-all-fields parsing; multiple replies accumulate; unknown field
  re-echo; bad date highlighted not guessed; slot free-text + callback paths;
  missing-required blocks Submit with highlighted fields; `/cancel` clears;
  TTL expiry; unlinked chat; supersede: opening /car while a reject
  conversation is armed. Harness style: mock prisma + spy `call()`, same as
  telegram-assign-e2e.
- **E2E on testing stack (scripts/server/verify-tg-car-request.sh)** — real
  bound user drives /car via the bot API against :3011, asserts the doc
  number arrives and the request lands as PENDING_APPROVAL with the correct
  window.

## 5. Out of scope (deliberate)

- Editing/cancelling requests from Telegram (web UI remains the place).
- Meeting-room / supply / travel requests via bot (same pattern later).
- Telegram Mini App (web form inside Telegram) — bigger change, separate plan.
- Photos/attachments on the request.
