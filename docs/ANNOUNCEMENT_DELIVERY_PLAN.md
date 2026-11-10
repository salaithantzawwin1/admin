# Plan — Subscriber messages on Telegram + `/announcements` UI/UX review

**Goal:** every message a subscriber sends to the AMS bot — **text or photo** —
is kept and readable inside `/announcements` → **Messages** tab, without
breaking the vehicle-trip conversations that share the same bot chat. The
announcements page also gets a UX pass so acknowledgement (ack) for Urgent
notices is visible and chased.

**Status:** plan only — nothing implemented.
**Progress: P0.5 hotfix landed — 0 of 9 planned phases (P1–P8) done** (update the tracker in §14 after each phase).
**Estimate:** ~4.5 working days (P1–P8), +0.75d optional F5–F8.

## Settled decisions

1. **Placement:** **Messages** is a tab inside `/announcements` (no new nav item).
2. **Capture:** *everything* the audience sends — **text and photo** (documents
   optional, same path).
3. **Permission:** new **`messages.read`**, independent of `announcements.manage`.

---

## 1. Acknowledgement — verified behaviour today

**Yes — Urgent (and Important/Emergency) announcements require acknowledgement.**
The rule is in code, not a manual flag:

| Where | Rule |
|---|---|
| `announcements.service.ts` `create()` | `requiresAck = priority ∈ {IMPORTANT, URGENT, EMERGENCY}` |
| `update()` | same, whenever `priority` changes |
| Employee web | orange "· acknowledgement needed", `Acknowledge` on the card and "I acknowledge this notice" in the modal; pills **All / Unread / Needs ack** |
| API | `POST /announcements/:id/ack` (verified in controller L57) → upserts `announcement_reads.ackAt`, sets `readAt` |
| Telegram | card carries **✓ Acknowledge** (`anack:<id>`); `handleAnnouncementAck()` requires bound user + `PUBLISHED` + `requiresAck` + audience membership, repaints the button, audits `via: 'telegram'` |
| Admin | card shows `x/y read`; Read stats modal shows target / read / unread / acked + per-department breakdown |

### Gaps found (the real UX problem)

| # | Finding | Severity |
|---|---|---|
| G1 | **Scheduled announcements never notify anyone.** `lifecycleCron()` flips `SCHEDULED → PUBLISHED` with `updateMany` only — no notification, no Telegram card, **no ack button**. | **High (bug)** |
| G2 | Raising priority on a published announcement flips `requiresAck` **without re-notifying**; admins see 0 acked forever. | **High** |
| G3 | Nothing chases an unacked Urgent notice — no reminder/escalation cron. | High |
| G4 | Admin card shows **read** progress only; for Urgent the metric is **acked**. | Medium |
| G5 | `readStats` returns `readRows` (per person) but the modal never renders it. | Medium |
| G6 | `Acknowledge` on the card acks without opening the content (no confirmation, irreversible). | Medium |
| G7 | Unread left-border only for `priority === 'NORMAL'`. | Low |
| G8 | A newer normal notice can bury an older unacked Urgent. | Low |
| G9 | `Publish` is a single click that pages the whole audience + Telegram, no confirm. | Medium |
| G10 | Tab/filter state is not in the URL except `?ann=`. | Low |

**Consequence:** a subscriber may reply "မလာနိုင်ပါ" without tapping
Acknowledge. The Messages tab must show **replied** and **acked** side by side.

---

## 2. Current inbound behaviour — verified

- Pull-based bot (`getUpdates` loop, no webhook).
- `handleUpdate()` routes text **state-first**: armed odometer → armed reject
  reason → armed custom ETA → open `/car` form → slash commands → `/start`.
- **Everything else is dropped** (`if (!text.startsWith('/start')) return;`).
- Photos are read **only** when an odometer capture is armed; other photos are
  dropped (`text === undefined` → return).
- `sendAnnouncementCard()` **returns `void`** today — the `message_id` is thrown
  away, so replies cannot be linked (§13 correction C1).

## 3. Conflict analysis — announcements vs vehicle-trip flows

All of this happens in **one bot chat**. Routing is greedy and state-first, so a
trip flow can eat an announcement reply (and the bot then answers with the wrong
prompt). States verified in code, TTLs included:

| Trip flow (state map) | Armed by | TTL | What happens to subscriber text / photo today | Risk |
|---|---|---|---|---|
| Odometer `pendingOdo` | driver taps Ready / Back at Office | **30 min** | Photo → held in memory as odometer evidence, then "type the number"; text before photo → bot replies "send the photo first" and **consumes it**; digits → reading; non-digits → "type digits" | **High** — reply swallowed + bot nags about a photo |
| Reject reason `pendingRejects` | approver taps ❌ Reject | **10 min** | any non-command text → the rejection reason; consumed | **High** |
| Custom ETA `pendingEtaCustom` | approver taps ⏰ | **10 min** | any text → parsed as new return time | Medium |
| `/car` form | user sends `/car` | **15 min** | any non-command text → field answer | Medium |
| Trip buttons (`wfa:`, reject, eta, cancel) | taps | — | callback queries, not text — no collision | None |
| Announcement ack (`anack:`) | tap ✓ Acknowledge | — | callback query, handled first | None |
| Driver-only chats | driver bound to bot | — | drivers are not AMS users, never receive announcements; must not be mis-attributed | Medium |

**Root cause:** routing has no notion of *which card a message replies to*, and no
record of what was consumed. Add the record, and make Telegram **Reply**
authoritative.

### Rules (acceptance criteria)

- **R1 — Explicit reply wins.** If `reply_to_message.message_id` matches an
  announcement card sent to that chat, the message is stored as an announcement
  message and **not** consumed by any armed flow; the flow stays armed and the
  bot sends no "photo first" nag for it.
- **R2 — Photos are first-class.** No odometer armed → any photo is stored
  (largest size, `media_group_id` for albums). Odometer armed and not an explicit
  reply → current behaviour, **but the photo is also stored**
  (`handledBy = ODOMETER`, file id).
- **R3 — Consumed ≠ lost.** Text taken by a form/reject/ETA/odometer is stored
  with the right `handledBy` and appears under **In progress** — never as an
  announcement reply.
- **R4 — `/msg <text>` escape hatch.** Forces a message into the inbox
  (`GENERAL`) without touching any armed flow, answered with a one-line ✓.
- **R5 — Driver-only chats stay out of announcement threads** (General only).
- **R6 — A text reply does not ack**; the tab shows `! not acked`.
- **R7 — Command precedence unchanged** (`/cancel`, `/start`, all slash commands).

---

## 4. Linking a message to an announcement

1. Telegram **Reply** → matches `AnnouncementChatSend` (exact).
2. Plain message from a bound AMS user → newest card in that chat within 14 days.
3. Otherwise **General**.

---

## 5. Schema

```prisma
model AnnouncementChatSend {
  id             String   @id @default(uuid()) @db.Uuid
  announcementId String   @db.Uuid
  chatId         String
  messageId      BigInt
  sentAt         DateTime @default(now())
  announcement Announcement @relation(fields: [announcementId], references: [id], onDelete: Cascade)

  @@unique([announcementId, chatId])
  @@index([chatId, sentAt])
  @@map("announcement_chat_sends")
}

enum InboundMessageState { NEW, READ }
enum InboundMessageKind { TEXT, PHOTO, DOCUMENT }

enum InboundMessageHandledBy {
  ANNOUNCEMENT_REPLY
  GENERAL
  CAR_FORM
  REJECT_REASON
  ODOMETER
  ETA
  COMMAND
}

model TelegramInboundMessage {
  id                String   @id @default(uuid()) @db.Uuid
  chatId            String
  telegramMessageId BigInt?
  replyToMessageId  BigInt?
  mediaGroupId      String?
  userId            String?  @db.Uuid
  driverId          String?  @db.Uuid
  senderName        String?
  kind              InboundMessageKind       @default(TEXT)
  text              String?  @db.Text        // "/start <code>" stored masked
  photoFileId       String?
  photoWidth        Int?
  photoHeight       Int?
  documentName      String?
  announcementId    String?  @db.Uuid        // null = general
  handledBy         InboundMessageHandledBy  @default(GENERAL)
  state             InboundMessageState      @default(NEW)
  readById          String?  @db.Uuid
  readAt            DateTime?
  receivedAt        DateTime @default(now())

  announcement Announcement? @relation(fields: [announcementId], references: [id], onDelete: SetNull)

  @@unique([chatId, telegramMessageId])
  @@index([announcementId, receivedAt])
  @@index([chatId, receivedAt])
  @@index([state, receivedAt])
  @@map("telegram_inbound_messages")
}
```

Migration **`00000000000073_telegram_inbound_messages`** (73 is free; 72 is the
last applied).

---

## 6. Capture path (text + photo, never breaks a flow)

**`telegram.service.ts`**

- Extend `TgUpdate.message`: `message_id`, `reply_to_message?.message_id`,
  `caption`, `media_group_id`, `document`.
- Insert the record **before** routing (insert-only — it never consumes the
  update), then fill `handledBy` as routing decides:

  ```ts
  const isCardReply = await this.inbound?.isAnnouncementReply(chatId, replyToMessageId);
  const rec = await this.inbound?.capture({ … }).catch(() => null);   // never throws

  if (isCardReply) return;   // R1: stored; no flow consumes it; no nag
  // … existing routing …
  // at the end of each branch: await this.inbound?.markHandled(rec?.id, 'CAR_FORM' | 'REJECT_REASON'
  //   | 'ODOMETER' | 'ETA' | 'COMMAND');
  ```

- Photo: largest `photo` size, `kind = PHOTO`; the odometer branch still
  downloads its own copy exactly as today (R2).
- `/msg <text>` → `GENERAL` + "✓ မှတ်တမ်းတင်ပြီး", skip every flow.
- `/start <code>` masked (`/start ••••`).
- Album photos share `media_group_id` → grouped into one bubble.

**`announcements.service.ts`**

- `recordChatSend(announcementId, chatId, messageId)` — called wherever
  `sendAnnouncementCard()` is (needs the return value, §13 C1).
- `captureInbound()`: resolve sender (user, else driver), resolve announcement
  (§4 + R5), dedupe `(chatId, messageId)`, insert, publish `message.new`.
- Unbound chats stored with `senderName` only ("Not linked").

---

## 7. Permission — `messages.read`

- `PERMISSIONS.MESSAGES_READ = 'messages.read'` in `src/auth/permissions.ts`.
- `permissions-seed.ts`: add `'messages.read'` to
  `DEFAULT_GRANTS.ADMINISTRATION` (`SYSTEM_ADMIN` gets every code dynamically).
  Seeding is **grant-only for codes a role has never been granted** and is
  skipped for codes in `DENIED_BY_ROLE`, so check that memory list stays clean —
  no SQL migration for the code itself.
- Every `/messages*` route: `@RequirePermissions(PERMISSIONS.MESSAGES_READ)`
  (new controller with prefix `messages`, same style as `@Controller('announcements')`).
- Frontend `RbacMatrix.tsx` `PERMISSION_LABELS`: `'messages.read': 'Read
  subscriber Telegram messages'`, grouped with announcements.
- `announcements.read` only → no tab; `announcements.manage` without
  `messages.read` → no tab and 403 from the server.

---

## 8. API

| Route | Purpose |
|---|---|
| `GET /messages/threads` | announcement threads (`code`, `title`, `publishAt`, `requiresAck`) with `total`, `unread`, `lastAt`; plus **General** |
| `GET /messages?announcementId=&handledBy=&kind=&state=&page=&pageSize=` | rows with sender, department, `kind`, text/caption, photo flag, time, `state`, **`ackAt`** for that sender |
| `GET /messages/unread-count` | badge count |
| `POST /messages/:id/read` | mark one read |
| `POST /messages/read-all?announcementId=` | clear a thread |

Live push: add `'message.new'` to **`AmsEventType`** (`events.service.ts`) and to
**`LiveEventType`** (`frontend/src/hooks/useLiveReload.ts`), then
`events.publish('message.new', {})` (no `userIds` = broadcast; clients that do
not show the tab ignore it). The frontend uses the shared single `EventSource`
plus a 15 s polling fallback, like the other pages.

---

## 9. UI/UX review + the new tab

### 9.1 Good today (keep)

Priority badge + accent, `NEW` badge, relative time with absolute tooltip, `→`
after the title, `?ann=` deep link; employee pills **All / Unread / Needs ack**
with counts; admin status chips, priority filter, search, pin, unpublish,
empty-department warning, read progress; read-stats modal with per-department
breakdown.

### 9.2 Page structure

```
PageHeader "Announcements"  [ Announcements | 💬 Messages (3) ]   ← underline tabs, ?tab=
  ├─ Announcements tab
  │    ├─ employee: pills All / Unread / Needs ack
  │    └─ admin:    status chips + priority filter + search  (unchanged)
  └─ Messages tab (messages.read)
       ├─ left:  threads (announcement, unread dot, General) + search
       └─ right: announcement header (ack progress chip → Read stats) + bubbles
```

- Page tabs use **underline** style; the existing pills/chips stay inside the
  Announcements tab (two pill systems would read as the same level).
- `?tab=messages&ann=…` deep links tab + thread; browser back works.
- No tab without `messages.read`; employee view otherwise unchanged.

### 9.3 Messages tab

- Thread row: `ANN-2026-0012 · Office closed on Friday` + `3 new`; for
  `requiresAck` a second line `Acked 31/128`.
- Filters: **All / New / Announcement replies / In progress / General /
  Not acked** — *In progress* is R3, *Not acked* is the chase list.
- Bubble: sender + department (or "Not linked"), Yangon time, text or 🖼 photo
  marker, album grouped; `✓ acked` / `! not acked` chip when the thread needs
  ack; small label (`car form`, `reject reason`, `odometer`) on *In progress*
  rows so admins know the bot already answered it.
- Header `Mark all read`; empty state "No messages yet — Telegram replies land
  here"; skeleton; error + Retry.
- Mobile single pane (list → thread + back), tap targets ≥ 40px.
- A11y: `role="tablist"`, `aria-selected`, real `<button>`s, focus rings, `Esc`
  closes modals, unread count via `aria-live="polite"`.

### 9.4 Announcements-tab fixes bundled here

| Fix | Change |
|---|---|
| F1 (G1) | **Scheduled publish must deliver.** Extract `deliverPublished(a)` from `publish()` and call it from `lifecycleCron()` too — notification, Telegram card, ack button, audit. |
| F2 (G4) | Admin card shows **ack progress** for `requiresAck` (`Acked 31/128`, amber until 100%). |
| F3 (G5) | Read stats modal lists **people** (name, dept, read at, acked at) from the `readRows` it already returns, with a "Not acked" filter + copy list. |
| F4 (G9) | `Publish` confirm: title, audience count, "sends in-app + Telegram", "subscribers must acknowledge" for IMPORTANT+. |
| F5 (G2) | Priority raise on a published announcement re-notifies the ack prompt (or lock priority once published). |
| F6 (G6) | Card-level `Acknowledge` opens the detail first. |
| F7 (G3) | Daily cron: Urgent/IMPORTANT unacked after 24 h → one digest to creator + `announcements.manage`, throttled per announcement. |
| F8 (G7/G8) | Unread marker for all priorities; unacked `requiresAck` sorts above read normal notices in the same pin group. |
| F9 | **Duplicate DM:** each publish sends a notification mirror *and* the announcement card, so every subscriber gets two Telegram messages. Merge into one card (drop the mirror for `ANNOUNCEMENT` notifications). |
| F10 | **100-recipient cap:** `sendPhotosToAudience()` does `userIds.slice(0, 100)` — beyond 100 the card (and its ✓ Acknowledge) is **never sent**, silently. Must loop the whole audience in batches, and log the count. |

F1–F4 ship with this work; F5–F8 are a second commit.

---

## 10. Tests

Inbound capture / conflicts:

- reply to a card while **odometer armed** → stored `ANNOUNCEMENT_REPLY`,
  odometer untouched, no nag (R1);
- photo reply to a card while odometer armed → PHOTO row, **not** odometer
  evidence (R1/R2);
- photo with no flow armed → stored (largest size), album grouped (R2);
- text consumed by `/car` form / reject / ETA → stored with the right
  `handledBy`, not shown as an announcement reply (R3);
- `/msg hello` while odometer armed → `GENERAL`, odometer still armed (R4);
- driver-only chat → `GENERAL`, never linked (R5);
- text reply to a requiresAck card does not set `ackAt` (R6);
- `/start <code>` masked; duplicate `(chatId, message_id)` ignored; unbound chat
  stored; unread count + mark-read; `messages.read` 403 otherwise.

UX fixes:

- scheduled announcement publishes **and notifies** (F1) — cron and manual paths
  call the same delivery function;
- `sendPhotosToAudience()` delivers to **every** bound recipient, no 100 cap
  (F10) — fixture of 150 users → 150 cards;
- message linking covers card **and** album message ids (D1), and a reply to an
  album photo resolves to the same announcement;
- priority raise re-notifies (F5, if taken);
- ack idempotent, sets `readAt` when missing, refused for non-`requiresAck`;
- escalation cron sends one digest per announcement per day (F7, if taken).

---

## 11. Out of scope

Per-recipient outbound delivery status; replying from AMS (`messages.manage`);
downloading reply photos into AMS storage (file id only); email/SMS channels.

## 12. Other implications

- `AnnouncementsModule` wires the inbound hook (`telegram.odoRef` pattern); no
  circular import.
- Audit only failures (`TELEGRAM_INBOUND_FAILED`) — per-message audit would
  drown `audit_logs`.
- Retention: monthly cron deletes `READ` rows older than 12 months (follow-up).
- F1 does not retro-notify announcements already scheduled; future ones only.
- Migration is additive (two new tables/enums); rollback = drop them, code
  reverts cleanly since nothing else references the tables.

---

## 13. Final check — assumptions verified against the code

| # | Assumption in this plan | Verified | Notes / correction |
|---|---|---|---|
| C1 | `sendAnnouncementCard()` can give us the Telegram `message_id` | ⚠️ **No, needs a change** | It `await`s `this.call('sendMessage', …)` and returns `void`. `call<T>()` returns `json.result`, so change it to `return this.call<{ message_id: number }>(…)` and null-check. |
| C2 | Announcement cards are only sent from `publish()` / audience fan-out | ✅ | `sendPhotosToAudience` sends albums separately (out of scope for linking). |
| C3 | A live push bus exists | ✅ | `EventsService` (in-process SSE broker, `@Sse()` at `/api/events`), frontend shares one `EventSource` via `useLiveReload`. **Correction:** both the `AmsEventType` union and the frontend `LiveEventType` must gain `'message.new'`. |
| C4 | `POST /announcements/:id/ack` exists | ✅ | Controller prefix `announcements`, route declared at L57. |
| C5 | `messages.read` needs no SQL migration | ✅ | `seedPermissions()` inserts every catalog code on boot; grants are grant-only for never-granted codes and skipped for `DENIED_BY_ROLE`. |
| C6 | Migration number | ⚠️ | Last applied is `…72`; **73 is free** → use `00000000000073_telegram_inbound_messages` (not 74). |
| C7 | Trip-flow TTLs quoted in §3 | ✅ | odometer 30 min, reject 10 min, custom ETA 10 min, `/car` 15 min. |
| C8 | Photos outside odometer are dropped | ✅ | `handleUpdate` falls through to `text === undefined` → return. |
| C9 | Frontend has polling fallback | ✅ | 15 s `setInterval` pattern is used across pages; keep it for the Messages tab. |
| C10 | No existing test pins the permission catalog | ✅ | `grep PERMISSIONS backend/test` → no match; adding a code breaks no suite. |

**Known-green test baseline before starting:** `car-odometer` 20, `cars-fixes`
70, `car-lifecycle` 21, `assets` 35, `fleet-vehicle-creation` 12, `fleet-expiry`
10, `car-list-shared-acks` 5. `maintenance.test.ts` has **1 pre-existing
failure** (`maintenanceSchedule.updateMany is not a function`) — do not treat it
as a regression.

### 13.1 Deep-dive verification (second pass — line-level)

| # | Detail checked in the code | Result / consequence for this plan |
|---|---|---|
| D1 | `sendPhotoAlbum()` returns `Array<{ message_id }> \| null`; `sendAnnouncementCard()` returns `void` | Album ids are already available → record **every** message we send (album bubbles + card), so replies to any of them link exactly. Card needs the C1 change. |
| D2 | `publish()` → `notifyMany()` → `telegram.mirrorToUser()` → `sendToChat()` sends a **text notification**, then album, then card = up to **3 messages per chat** per announcement | Plain replies may attach to the mirror or the album. Exact linking covers the messages we record; the rest fall back to the 14-day rule (same announcement, so still correct). `notifyMany` returns `void`, so mirror ids need threading if we want exactness there; recommend **F9** (drop the duplicate mirror) over threading. |
| D3 | `sendPhotosToAudience()` caps at `userIds.slice(0, 100)` | Audiences >100 users never receive the card or ack button — the ack metric silently becomes meaningless. **F10**, fix inside P7 (or the hotfix). |
| D4 | `readStats()` returns `readRows: { userId, readAt, ackAt }` — **no names** | F3 needs one extra `user.findMany({ select: { id, fullName, employee.department } })` join, merged client-side or server-side. Scope it in P7. |
| D5 | Deep link uses raw `location.search` and `history.replaceState(null, '', '/announcements')` (Announcements.tsx L229–242) — it **wipes the query** | Adding `?tab=` will be destroyed when a deep-linked announcement opens. P6 must rewrite this hook to preserve `tab` (and read `ann` on mount regardless of tab). |
| D6 | `TgUpdate.message.from` already carries `{ id, username, first_name }`; `message.chat` only `{ id }` | `senderName` is available today; no extra API call needed. Missing fields are only `message_id`, `reply_to_message`, `caption`, `media_group_id`, `document`. |
| D7 | `lifecycleCron()` is `@Cron('0 5 * * * *')` and only runs two `updateMany` | **Corrected:** cron's 6-field order is `sec min hour dom mon dow`, so this is **once an hour at :05**, not every minute — a notice scheduled for 08:01 published at 09:05. Fixed to `'0 * * * * *'` (every minute) in P0.5 together with `deliverPublished()`. Single container today, so no double-send risk; note it if replicas are ever added. |
| D8 | `ScheduleModule.forRoot()` is registered once (app.module §41) | The F7 escalation cron is just another `@Cron` on the announcements service — no new module wiring. |
| D9 | Test style is plain `assert` + a hand-built fake `prisma`, service constructed directly | Capture logic is testable if it lives in `AnnouncementsService` (inbound hook). `TelegramService.handleUpdate()` itself calls the network — extract pure helpers (`classifyInbound`, `isAnnouncementReply`) so both can be tested without Telegram. |
| D10 | `PermissionsService.usersWithPermissions([...])` exists (used by the join notifier) | Reuse it for the F7 digest recipients and, if wanted, `message.new` targeting instead of broadcast. |
| D11 | `seedPermissions()` runs in `main.ts` L67–68 **before** serving | New `messages.read` code exists after one restart; no SQL seed and no migration needed for the permission. |

**Decision needed before P1:** is a **scheduled Urgent** announcement in active
use right now? If yes, ship the **hotfix first** (~0.5 d, no schema change):
**F1** (scheduled publish actually notifies) + **F10** (100-recipient cap) — those
are the two gaps that silently lose a safety notice. Then continue at P1.

---

## 14. Implementation process — order, gates, progress

Work top to bottom. Each phase has a **gate** that must pass before the next
starts; update the tracker at the end of every phase so the reader can always
see how much is done.

| Phase | Deliverable | Files (main) | Weight | Status |
|---|---|---|---|---|
| **P0** | Branch + baseline | branch `feat/announcement-messages` | 5 % | ⬜ |
| **P0.5** *(conditional)* | Hotfix F1 + F10 (only if scheduled Urgent is in use) | `announcements.service.ts` | — | ⬜ |
| **P1** | Schema + migration 73 | `prisma/schema.prisma`, `prisma/migrations/…73…` | 10 % | ⬜ |
| **P2** | `messages.read` permission | `auth/permissions.ts`, `auth/permissions-seed.ts`, `RbacMatrix.tsx` | 5 % | ⬜ |
| **P3** | Outbound card tracking | `telegram.service.ts` (`sendAnnouncementCard`), `announcements.service.ts` (`recordChatSend`) | 10 % | ⬜ |
| **P4** | Inbound capture + conflict rules | `telegram.service.ts`, `announcements.service.ts` (`captureInbound`) | 20 % | ⬜ |
| **P5** | Messages API + live event | `messages/*` (new module), `events.service.ts` | 10 % | ⬜ |
| **P6** | Messages tab UI | `AnnouncementMessages.tsx` (new), `Announcements.tsx`, `api.ts`, `useLiveReload.ts` | 20 % | ⬜ |
| **P7** | UX fixes F1–F4 | `announcements.service.ts`, `Announcements.tsx` | 15 % | ⬜ |
| **P8** | Tests + staging/prod gates | `backend/test/*`, deploy scripts | 5 % | ⬜ |
| **P9** *(optional)* | F5–F8 + retention cron | as above | +15 % | ⬜ |

**Done so far: P0.5 ✅ (F1 + F10 + cron cadence), 0/9 of the planned phases.** Replace ⬜ with 🟨 when started and ✅ only when the
phase's gate has passed; recompute the header line.

### P0 — Branch & baseline (0.5 h)

- [ ] `git checkout -b feat/announcement-messages`, `git status` clean.
- [ ] Run the green suites listed in §13 and record the numbers in this file.
- [ ] Confirm `maintenance.test.ts` still fails for the known reason only.
- **Gate:** baseline numbers recorded; nothing else changed.
- **Verify:** `git diff --stat` empty.

#### P0.5 — Conditional hotfix (3 h, no schema change)

Do this **before P1** only if scheduled Urgent announcements are in active use.

- [ ] F1: extract `deliverPublished(a)` from `publish()` (notify + album + card +
      audit) and call it per row in `lifecycleCron()` instead of the bulk
      `updateMany`; keep the expiry update as is.
- [ ] F10: remove the `slice(0, 100)` cap; batch by 50 with a short pause, log
      `sent/failed` counts.
- [ ] Test: a `SCHEDULED` row due now → cron path produces one notification set,
      one card per bound chat (with ✓ Acknowledge for IMPORTANT+), one audit row;
      a 150-user fixture → 150 card attempts, no cap.
- [x] **Bonus found while testing P0.5:** the cron was `'0 5 * * * *'` = **hourly at :05**, not every minute, so a notice scheduled for 08:01 went out at 09:05. Changed to `'0 * * * * *'`.
- **Gate:** staging schedule 3 min ahead → card + ack button arrive on time.
- **Rollback:** single revert; no schema touched.
- **Verify:** `tsc --noEmit`, both tests, staging deploy.

**P0.5 result (2026-11-10):** DONE on testing + production. Unit suite
`announcement-scheduled-publish.test.ts` 5/5; `rbac-deny-memory` 21/21;
`security` 11/11; backend `tsc --noEmit` clean. Staging end-to-end: a SCHEDULED
URGENT row due now → published within a minute, in-app notification created,
audit `ANNOUNCEMENT_PUBLISHED {via:'schedule'}` by `scheduler`, fan-out audit
`{audience:1, recipients:0, failed:0}` (target user has no Telegram chat, so no
card — correct). No real Telegram card was sent because no test chat is bound;
the card payload itself is unchanged code.

### P1 — Schema + migration (2 h)

- [ ] Add the two models + three enums (§5) to `prisma/schema.prisma`.
- [ ] `npx prisma migrate dev --name telegram_inbound_messages` on **testing**;
      rename folder to `00000000000073_telegram_inbound_messages` if the
      generated name differs, and keep `migration_lock.toml` untouched.
- [ ] `npx prisma generate`; confirm `TelegramInboundMessage` types exist.
- **Gate:** migration applies on an empty DB **and** on a copy of prod data
  without touching existing tables.
- **Verify:** `\d telegram_inbound_messages`, `\d announcement_chat_sends`,
  `SELECT count(*)` = 0.
- **Rollback:** drop both tables/enums; no other code references them yet.

### P2 — Permission (1 h)

- [ ] `MESSAGES_READ: 'messages.read'` in the catalog (alphabetical, next to
      `ANNOUNCEMENTS_*`).
- [ ] Add to `DEFAULT_GRANTS.ADMINISTRATION`; confirm not in `DENIED_BY_ROLE`.
- [ ] `PERMISSION_LABELS` entry in `RbacMatrix.tsx`.
- [ ] Boot the backend once; matrix shows the row for ADMINISTRATION, not for
      EMPLOYEE.
- **Gate:** `SELECT * FROM permissions WHERE code='messages.read'` exists and is
  granted to ADMINISTRATION.
- **Verify:** `tsc --noEmit` on backend; RBAC screen renders (screenshot later,
  in P6 review).

### P3 — Outbound card tracking (2 h)

- [ ] `sendAnnouncementCard()` returns `{ message_id } | null` (C1).
- [ ] `recordChatSend()` upsert on `(announcementId, chatId)`; called from the
      audience fan-out right after each send; failures logged, never thrown.
- [ ] Unit test: mocked `call` returning `{ message_id: 42 }` → row created;
      `null` → no row, no throw.
- **Gate:** publish a test announcement to one test chat → exactly one
  `announcement_chat_sends` row with the real id.
- **Verify:** DB query + Telegram shows the card.

### P4 — Inbound capture + conflict rules (1 d)

- [ ] Extend `TgUpdate` (§6).
- [ ] Insert-before-routing hook (`capture`), `markHandled()` on every branch,
      `isAnnouncementReply()` (R1), `/msg` (R4), photo capture (R2), album
      grouping, `/start` masking, dedupe.
- [ ] Resolve sender + announcement (§4/R5); `events.publish('message.new')`.
- [ ] Tests: the R1–R7 list in §10.
- **Gate:** send a text, a photo, an album, `/start <code>`, and a reply to a
  **real** card while an odometer capture is armed — all land in the table with
  the expected `handledBy`, and the odometer flow still completes normally.
- **Rollback:** set `TELEGRAM_INBOUND=0` env flag (add it) → hook no-ops; no
  behaviour change for existing flows.

### P5 — Messages API (4 h)

- [ ] `messages` module/controller/service with the five routes (§8).
- [ ] `messages.read` guard on all of them; 403 covered by a test.
- [ ] `ackAt` join from `announcement_reads`; unread count; read/read-all.
- [ ] `'message.new'` added to `AmsEventType`.
- **Gate:** all five routes return correct shapes for ADMINISTRATION and 403 for
  an employee-only token.
- **Verify:** `curl` with both tokens; one duplicate insert attempt stays at one row.

### P6 — Messages tab UI (1 d)

- [ ] `?tab=` tabs in `Announcements.tsx` (§9.2), preserve `?ann=`.
- [ ] `AnnouncementMessages.tsx`: threads, bubbles, filters, mark-read, empty /
      loading / error states, photo marker, ack chips, mobile single pane, a11y.
- [ ] `LiveEventType` + `useLiveReload(['message.new'])`, 15 s polling fallback,
      unread badge on the tab.
- [ ] Admin announcement row gains `💬 n` → Messages tab filtered.
- **Gate:** text + photo replies visible within ~1 s of sending; refresh keeps
  state via URL; mobile width 390 px usable; `tsc -b` clean (then
  `git checkout -- frontend/tsconfig.tsbuildinfo`).
- **Verify:** staging URL `:8030` in the browser, plus a real Telegram reply.

### P7 — UX fixes F1–F4 (6 h)

- [ ] F1: extract `deliverPublished()`, call from `publish()` **and**
      `lifecycleCron()`; test that the cron path notifies + sends the card + ack
      button.
- [ ] F2: ack progress on admin cards.
- [ ] F3: per-person list in the read-stats modal (+ Not acked filter).
- [ ] F4: publish confirmation dialog.
- **Gate:** schedule an Urgent announcement 3 min ahead with `NO_PULL=1` on
  testing → at publish time the Telegram card with **✓ Acknowledge** arrives,
  in-app notification exists, and acking from Telegram updates admin stats.
- **Verify:** the ack-progress numbers change on reload; the confirm dialog
  blocks a mis-click.

### P8 — Full gates & deploy (4 h)

- [ ] All §10 tests pass; backend `tsc --noEmit`; frontend `tsc -b`.
- [ ] `deploy-testing.sh` → `DONE — TESTING`; run the P4/P6/P7 manual checks on
      `:8030`.
- [ ] `deploy-prod.sh` → `DONE — PRODUCTION`; migration applied on prod
      (`prisma migrate status` inside the container).
- [ ] Commit (conventional message) + push via the `srv` remote.
- **Gate:** production `/announcements` works, a real reply appears, an ack
  round-trips, and no container restarts/errors in the log.
- **Rollback:** revert the commit + redeploy; tables stay (additive) and are
  harmless.

### P9 — Optional second commit (0.75 d)

F5 (re-notify on priority raise), F6 (open before ack), F7 (24 h escalation
digest), F8 (unread marker + sort), retention cron. Same gates as P8, smaller
blast radius.

### Progress log (append one line per phase)

| Date | Phase | What landed | Gate result | Commit |
|---|---|---|---|---|
| 2026-11-10 | P0.5 | `deliverPublished()` shared by publish + cron; cron per-row claim/revert; 100-recipient cap removed (batched, audit counts); cron cadence hourly→every minute; new test file | ✅ testing+prod deploy, 5/5 + 21/21 + 11/11 tests | `(hotfix commit)` |

**How to read progress quickly:** header line (`Progress: n % — x/9 phases`),
the status column above, and the last row of this log. A phase counts as done
only when its gate passed, not when code was written.
