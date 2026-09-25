# Plan — Telegram `/car` Conversational Request Flow (Phase 2)

**Goal:** a requester who is out of the office creates and submits a car
request entirely inside Telegram — no VPN, no office WiFi, no browser.
After submission the existing chain takes over unchanged: approval buttons →
`/assign` picker → driver ack stages → Back at Office.

**Status:** plan only — not yet implemented. Estimate: 1–2 working days.

---

## 1. What already exists (reuse, don't rebuild)

| Building block | Where | Reuse for /car |
|---|---|---|
| Slash-command hook | `TelegramService.commands` (wired by `TelegramCarActionsService.wire()`) | register `/car` + `/cancel` handlers |
| Text-conversation state machine | `pendingRejects` Map + TTL + `/cancel` + supersede rules | same pattern for `pendingCarRequests` |
| Service-layer creation + validation | `CarsService.createCarRequest()` (dates, 17:00 default end, doc number, audit) | call it directly — bot never writes Prisma itself |
| Submission | `WorkflowService.submit()` (guard: requester only, DRAFT only) | submit right after create, as the same actor |
| Bound-user resolution | `TelegramCarActionsService.boundUser(chatId)` | identify the requester |
| Permission gating | `PermissionsService.forUser()` | request permission check (`requests.create` / authenticated user) |
| Clash warning | `CarsService` availability/conflicts logic (used by web form) | pre-submit double-booking hint |
| Confirmation card + Open in AMS | `sendRaw` + `webUrl` deep link | final summary card with doc number |

## 2. Conversation design

```
User: /car
Bot:  🚗 New car request (type /cancel to abort)
      1/6 — Destination?
User: Mandalay site visit
Bot:  2/6 — Start date & time?  (YYYY-MM-DD HH:MM, Yangon time)
User: 2026-09-28 08:30
Bot:  3/6 — Time slot?
      [☀️ Full day] [🌅 Half AM] [🌆 Half PM] [⏱ Custom]   ← inline buttons
      (Custom → asks "End date & time?")
Bot:  4/6 — How many passengers?
User: 3
Bot:  5/6 — Pickup location?  (or /skip)
Bot:  6/6 — Purpose?  (or /skip)
Bot:  📋 Summary — destination, window, slot, passengers, pickup, purpose
      + ⚠️ clash hint if another booking overlaps this window
      [✅ Submit] [❌ Cancel]                                 ← inline buttons
Bot:  → CarsService.createCarRequest(...) as the bound user
      → WorkflowService.submit(...)
Bot:  ✅ Submitted as CAR-202609-0042 — waiting for approval.
      [Open in AMS]
      → approvers receive the existing [✅ Approve][❌ Reject] card
```

Rules:
- One question per message; free text answers; step 3 uses inline buttons.
- `/cancel` at any point aborts and clears state (supersedes an armed reject
  conversation, same as approve already does).
- Destination and start time are required; everything else has defaults
  (slot = FULL_DAY, passengers = 1, end = 17:00 same day).
- Slot buttons answer via callback — no free-text slot parsing.
- Date parsing: accept `YYYY-MM-DD HH:MM` and `YYYY-MM-DD HHMM`; reply with a
  re-ask message on garbage input (never guess).

## 3. Implementation steps

1. **State** — `pendingCarRequests: Map<chatId, { step, draft, at }>` in
   `TelegramCarActionsService` (TTL 15 min, size cap 200, sweep on arm —
   copy the `REJECT_TTL_MS` pattern).
2. **Handlers** — `handleCarCommand(text, chatId)` returns true for `/car`;
   `handleCarText(text, chatId)` advances the conversation; new callback
   tokens `wfa:slot:<SLOT>` / `wfa:carsubmit` / `wfa:carcancel` wired into
   `handleCallback`'s token switch.
3. **Ordering** — in `TelegramService.handleUpdate`, the armed-conversation
   check runs BEFORE the slash-command fallback (mirrors the rejects hook),
   so `/cancel` and answers are consumed while a /car conversation is open.
4. **Actor** — every action runs as the bound AMS user (never a bot identity),
   so audit trail + "requester only can submit" hold automatically.
5. **Gates** — unlinked chat → "not linked" error; user without any roles →
   reject; disable the flow entirely when `telegram.enabled` is false (already
   the bot-wide gate).
6. **Success card** — doc number + status + Open-in-AMS deep link; the
   approval card goes to approvers through the existing `onSubmittedTelegram`
   hook — zero new notification code.
7. **Registration** — wire in `CarsModule.onApplicationBootstrap` next to the
   existing hooks; add `/car — request a vehicle` to the bot's command list.

## 4. Testing

- **Unit (test/telegram-car-request.test.ts)** — happy path all steps;
  `/cancel` mid-flow; TTL expiry; garbage date re-ask; slot via callback;
  unlinked chat; user without permission; submit fails (no workflow) → error
  shown, state cleared; supersede: opening /car while a reject conversation is
  armed. Harness style: mock prisma + spy `call()`, same as telegram-assign-e2e.
- **E2E on testing stack (scripts/server/verify-tg-car-request.sh)** — real
  bound user drives /car via the bot API against :3011, asserts doc number
  arrives and the request lands as PENDING_APPROVAL with correct window.

## 5. Out of scope (deliberate)

- Editing/cancelling requests from Telegram (web UI remains the place).
- Meeting-room / supply / travel requests via bot (same pattern later).
- Telegram Mini App (web form inside Telegram) — bigger change, separate plan.
- Photos/attachments on the request.
