# Overdue Return Guard — Implementation Plan

Status: proposed (not implemented)
Owner: Administration / Fleet (AMS)
Related: `docs/ODOMETER_OCR_PLAN.md`, `docs/CRON_AUDIT.md`
Reference incident: **CAR-202611-0039** (18 Nov 2026)

---

## 1. Problem

A driver who taps **Noted** and **Ready** but never taps **🏁 Back at Office** is
auto-completed by the janitor 15 minutes after the planned end. The request flips
to `COMPLETED`, the vehicle goes back to `AVAILABLE`, and the car is offered to
the next requester **while it is still physically on the road**.

### 1.1 Evidence from CAR-202611-0039 (production DB, times in Yangon)

| Time | Event |
| --- | --- |
| 09:18 | Assigned — vehicle 9F1213, driver Naing Naing Tun |
| 09:20 / 09:30 | `DRIVER_NOTED` / `DRIVER_ARRIVED` (Ready) |
| 09:27 | Departure dashboard photo + text `341626` (filed later, after the fix in `6440a88`) |
| **12:30** | Planned end (`car_requests.endDate`) |
| **13:00** | Cron `releaseExpired` → `REQUEST_AUTO_COMPLETED` "Window ended without Back at Office", assignment released, vehicle `AVAILABLE` |
| **13:25** | Driver actually returns — BACK photo + `341651`, `DRIVER_RETURNED` |

Facts that matter:

- The ride had **no `car_trips` row at all** (the Telegram driver flow never
  created one), so both "running late" guards — which only look at
  `trip.status = 'STARTED'` — did not apply.
- `car_assignments.startOdoAt` was **null** at 13:00 (the departure number was
  still missing; the 12:20 nudge listed both kilos as missing). `driverArrivedAt`
  was set, and the departure photo was already in the group — that is the ride
  evidence that existed.
- Between 13:00 and 13:25 the car was assignable to another request. The late
  BACK reading was still recorded on the released row, so no data was lost —
  only the **double-booking risk** was real.

### 1.2 Root cause

`releaseExpired()` (`backend/src/cars/trip-reminders.service.ts:205`) decides by
*tap state*, not by *physical state*:

```
driverBackAtOfficeAt           → finalise COMPLETED
sharedTripId                   → close with the group / keep live
driverNotedAt || driverArrivedAt → auto-COMPLETE (window over)
otherwise                      → release back to pool (APPROVED)
```

The third branch treats "driver acknowledged + window ended" as "ride finished",
although the only proof of return is the Back tap (or a return odometer).

---

## 2. Goals / non-goals

**Goals**

1. A request is never auto-completed without evidence that the car came back.
2. While a ride is out past its window, the vehicle stays `IN_USE` and cannot be
   assigned, offered in pickers, or counted as available — in the fleet list,
   the requester's fleet card, the conflict check and Telegram.
3. Administration is told, in-app and on Telegram, that a manual close is
   required; the driver keeps being nudged.
4. Administration can close the trip manually with the return odometer; the
   close is audited, notified like a driver Back tap, and **does not pretend the
   driver tapped** (the missing tap stays visible to discipline).

**Non-goals**

- No change to the driver flow, prompts, or odometer capture.
- No change to how `COMPLETED` feeds the discipline report.
- No auto-complete "after N hours" fallback: an overdue ride is closed by a
  human, never by a timer.

---

## 3. Target behaviour

| Situation | System action |
| --- | --- |
| Driver taps 🏁 Back at Office | Complete as today. Missing return km → keep the existing hourly admin odometer nudge (no block). |
| Window (or ⏰ ETA, when later) ended + 15 min, ride evidence exists, no Back tap | **Do not close.** Assignment stays live, vehicle stays `IN_USE`, badge shows **Overdue return**, driver nudged (Telegram). |
| Overdue by ≥ 2 h | Admin alert: in-app notification + Telegram mirror — "manual close needed". Repeats at most every 12 h, then once a day after 25 h. |
| No ride evidence at all (no Ready, no departure km, no STARTED trip) | Release as today: vehicle + driver back to pool, request `APPROVED`. |
| Admin manual close | Return km (or explicit estimate + reason) → audited BACK odometer (no fake driver stamp) → trip/request `COMPLETED` → car freed → requester + driver notified. |

Definitions:

- **Ride evidence** = `startOdoAt != null` **or** `driverArrivedAt != null`
  **or** `trip.status = 'STARTED'`. Ready alone is enough: the driver said the
  car left the office. One predicate owns this (`outOnRoadWhere` /
  `isOutOnRoad`, Step 1) — every reader imports it instead of re-writing the
  `OR`.
- **Effective end** = `estimatedReturnAt ?? carRequest.endDate`. The janitor
  already waits for a ⏰ ETA, so every overdue decision (hold, nudge, escalation,
  digest) is measured from the effective end, never from the bare `endDate`.
- **Overdue** = `releasedAt = null`, `driverBackAtOfficeAt = null`,
  **effective end** `< now`, and ride evidence.

---

## 4. Code map (current)

| Area | File / symbol |
| --- | --- |
| Janitor | `backend/src/cars/trip-reminders.service.ts:205 releaseExpired`, cron `0 */30 * * * *` (`:204`), `RELEASE_GRACE_MS = 15 min` (`:212`), sweep query `include` `:230` |
| Driver nudge + admin escalation | same file `:1228 escalateOverdueRunning`, hourly at `:15`, `ESCALATED` 12 h throttle at `:1265` |
| Odometer-missing nudge | same file `:786 odometerMissingNudge`, hourly at `:20` (already flags a Back tap without return km) |
| Fleet badge (admin) | `backend/src/fleet/fleet.service.ts:511` `startedTrips` in `listVehicles` (`:484`) → `IN_USE` |
| Fleet badge (requester) | `backend/src/cars/cars.service.ts:403` `startedTrips` in `requesterFleetOverview` (`:335`), `coversNow` `:420` |
| Vehicle conflict check | `backend/src/cars/cars.service.ts:540 overlaps` (`checkAvailability` `:534`), plus `driverClash` (`:618`) |
| Telegram assign picker | `backend/src/cars/telegram-car-actions.service.ts:714` (status `AVAILABLE` / `IN_USE`) |
| Driver Back tap | `backend/src/cars/cars.service.ts:955 captureOdometer` (photo gate `:1021`, BACK stamp via `manualAck` `:1072–1075`, audits `CAR_ODOMETER_RECORDED`) |
| Admin "complete trip" | `backend/src/cars/cars.service.ts:2414 completeTrip` — requires an existing `STARTED` trip (`:2420`), so it cannot close today's no-trip rides |
| Admin odometer UI | `frontend/src/components/OdometerBox.tsx` (record/edit both stages, `canManage`), used in `CarPanel.tsx:500` |
| Trip panel | `frontend/src/components/CarPanel.tsx` |

---

## 5. Implementation steps

### Step 1 — Janitor holds instead of closing

`trip-reminders.service.ts`

1. **One predicate, one definition.** Add `backend/src/cars/overdue.util.ts`:

```ts
// "the ride left the office and has not been closed out"
// startOdoKm is the km, startOdoAt its capture time — captureOdometer writes both
export const outOnRoadWhere = {
  releasedAt: null,
  driverBackAtOfficeAt: null,
  endOdoAt: null,
  OR: [
    { startOdoKm: { not: null } },
    { startOdoAt: { not: null } },
    { driverArrivedAt: { not: null } },
  ],
};

export function isOutOnRoad(a: {
  releasedAt: Date | null; driverBackAtOfficeAt: Date | null; endOdoAt: Date | null;
  startOdoKm: number | null; startOdoAt: Date | null; driverArrivedAt: Date | null;
}): boolean {
  if (a.releasedAt != null || a.driverBackAtOfficeAt != null || a.endOdoAt != null) return false;
  return a.startOdoKm != null || a.startOdoAt != null || a.driverArrivedAt != null;
}
```

   Both arms matter: a typed departure km is ride evidence even when the Ready
   tap never landed. Also extend the sweep `include` (`:230`) with
   `driverArrivedAt: true, startOdoAt: true, endOdoAt: true`. Do **not** add
   `trip`: the sweep `where` already restricts to `trip: null` /
   `NOT_STARTED`, so a `STARTED` trip never reaches the loop.

2. Insert the hold branch **after** the shared-trip block and **before** the
   `driverNotedAt || driverArrivedAt` auto-complete branch:

```ts
// The convoy branch above must stay FIRST. "Back at Office" is a per-row stamp
// (telegram.manualAck stamps one row; captureOdometer copies the reading to the
// partner rows but not the tap), so a partner whose own window closed early can
// carry zero evidence on its row while the group has long returned. Holding
// before the group check would keep that row live for ever and the convoy would
// never close.
if (isOutOnRoad(a)) {
  // still out: keep the assignment live, keep the car held
  if (a.vehicleId) {
    await this.prisma.vehicle
      .update({ where: { id: a.vehicleId }, data: { status: 'IN_USE' } })
      .catch(() => undefined);
  }
  await this.auditHeldOnce(a);   // CAR_OVERDUE_RETURN_HELD, max once / 12 h
  console.log(`[cars] holding ${a.request.docNumber} — ride out past window, no Back tap`);
  continue;
}
```

   Final branch order: (a) `driverBackAtOfficeAt` → finalise (unchanged);
   (b) `sharedTripId` → group logic (a live partner keeps the member live, a
   group that rode closes the member `COMPLETED`); (c) `isOutOnRoad` → hold;
   (d) `driverNotedAt || driverArrivedAt` → the old auto-complete, now reachable
   only by a Noted tap with no Ready tap and no departure km (no ride evidence).

3. `auditHeldOnce` mirrors `auditLogCreateSafe` usage: write
   `CAR_OVERDUE_RETURN_HELD` with `{ vehicleId, driverId, endDate, minutesOver }`
   only when no such audit exists for the request in the last 12 h (same throttle
   style as `escalateOverdueRunning`).
4. Do **not** send a requester notification here (the existing "auto-closed"
   notice disappears naturally; the trip stays open in their view).

5. **The same cron's self-heal must learn the new hold.** `releaseExpired` ends
   with `renormalizeVehicleStatuses()` (`:484`), which flips any `IN_USE`
   vehicle back to `AVAILABLE` when it can see no booking `endDate >= now` and
   no `STARTED` trip. A held ride has neither, so without this the status write
   above is undone in the same tick (plus a `VEHICLE_AUTO_FREED` audit every
   30 min). Add the held assignment to `hasLive`:

```ts
assignments: {
  where: { releasedAt: null, driverBackAtOfficeAt: null, endOdoAt: null,
           OR: [{ startOdoKm: { not: null } }, { startOdoAt: { not: null } },
                { driverArrivedAt: { not: null } }, { trip: { status: 'STARTED' } }] },
  select: { id: true },
},
```

   `freeOrphanedDrivers()` needs no change: it keeps a driver `ON_TRIP` while an
   `IN_PROGRESS` assignment with `releasedAt = null` exists, which is exactly the
   held state.

Acceptance: for a fixture like CAR-202611-0039 the request stays `IN_PROGRESS`,
`releasedAt` stays `null`, vehicle status is `IN_USE` **after the next 30-minute
sweep too**, one audit row is written, and nothing is sent to the requester. A
convoy partner whose own window closed early still closes with its group — no
`CAR_OVERDUE_RETURN_HELD` row for it.

### Step 2 — Escalation: driver nudge from +15 min, admin alert at +2 h

`escalateOverdueRunning` (`:1228`) becomes the single overdue authority. Two
prerequisites before the staging below:

**a. Make it ETA-aware, like the janitor.** Its `where` (`:1231–1236`) only tests
`request.carRequest.endDate < now`, so a driver who reported a ⏰ ETA is nudged
and escalated at the planned end while the janitor correctly waits. Mirror the
sweep clause — overdue means
`COALESCE(estimatedReturnAt, carRequest.endDate) < now`:

```ts
where: {
  releasedAt: null,
  driverBackAtOfficeAt: null,
  OR: [
    { request: { carRequest: { endDate: { lt: now } } }, estimatedReturnAt: null },
    { estimatedReturnAt: { lt: now } },
  ],
},
```

Compute `overMins` / `when` (`:1245–1247`) from that same effective end, so
"2 h over" means 2 h past the ETA, not past the original window.

**b. Include the trip status.** Add `trip: { select: { status: true } }` to the
`include` (`:1237`). Today it selects driver/vehicle/request only, so the
function cannot tell a held row (no trip / `NOT_STARTED`) from a `STARTED`
trip — exactly the split the two stages below need.

1. Keep the driver Telegram nudge (hourly). Add a cap: skip nudges after
   `overMins > 24 * 60`; from then on the daily digest carries it.
2. **Two stages, not one.** The cron already alerts Administration on the first
   hourly tick after the window. Keep that immediate alert for
   `trip.status = 'STARTED'` rows (an existing safety net that must not regress)
   and add a second, distinct
   "manual close required" alert at `overMins >= 120` for **held** rows (`trip`
   absent or `NOT_STARTED`).
   The current 12 h throttle keys on `notifications.type = ESCALATED` for the
   request (`:1265`), so reusing it would swallow the +2 h alert behind the
   earlier one.
   The second stage needs its own marker (audit action
   `CAR_OVERDUE_CLOSE_REQUIRED`, throttled 12 h) and its own notification title.
3. After 25 h the admin alert drops to once a day (same marker, 24 h window)
   instead of 12-hourly.
4. Update the copy to match the new flow:

```
title: 🏁 Return overdue — CAR-… (2h 15m)
body : Naing Naing Tun has not tapped "Back at Office". 9F1213 is still held
       and cannot be assigned. Close the trip manually with the return km
       from the request page (Cars → request → Odometer / Close trip).
```

5. Mirror the same line to Administration's Telegram (same pattern as
   `notifyReadyToAssign`'s `telegram.mirrorToUser` loop).
6. `dayEndDigest` needs a **third bucket**. Its current `noBack` filter keeps
   only `APPROVED`/`COMPLETED` requests with no `STARTED` trip, so a held ride
   (`IN_PROGRESS`) appears in neither `noBack` nor `mileageOpen` and silently
   drops out of the digest; the "Auto-closed" heading would also become a lie
   once Step 1 lands. Add `overdue` (held, `endDate` today, no Back tap) and
   render it first: `🏁 Overdue returns — close with the return km`.

Acceptance: with effective end `now − 30 min`, driver nudge only (plus the
existing immediate alert for a `STARTED` trip); with effective end `now − 3 h`,
the extra `CAR_OVERDUE_CLOSE_REQUIRED` alert + Telegram mirror once, and again
only after 12 h; after 25 h it drops to once a day; an ⏰ ETA 2 h beyond the
window suppresses nudge, hold and escalation until that ETA passes.

### Step 3 — Badge: "departure recorded, return missing" holds the car

The predicate and its Prisma fragment already exist from Step 1
(`backend/src/cars/overdue.util.ts` — `outOnRoadWhere` / `isOutOnRoad`). Every
reader below imports them; there is no second definition to drift.

Then replace the `startedTrips` queries with an OR of both holds:

- `fleet.service.ts:511` (`listVehicles`, `:484`) — union `STARTED` trips and
  `outOnRoadWhere`; the row already maps to `IN_USE`. Add
  `overdueReturn: boolean` to the returned row.
- `cars.service.ts:403` (`requesterFleetOverview`, `:335`) — same union, keep
  `effectiveEnd` so an ETA still stretches the coverage; add `overdueReturn`.
  **Careful:** for an overdue ride `lateEnd` is already in the past, so
  `lateEnd >= now` is false and the badge would still read AVAILABLE (or BOOKED
  through the `mine.length` fallback). The hold must force `coversNow = true`
  directly (`|| heldNow.has(v.id)`), not travel through the ETA map.
- `fleet.service.ts:733` (busy/availability maps) — same union.
- `cars.service.ts overlaps()` — after the ETA-stretched conflict filter, add:

```ts
// after the ETA-stretched conflict filter, before the shared-group reconciliation
const now = new Date();
const held = await this.prisma.carAssignment.findFirst({
  where: {
    vehicleId, ...outOnRoadWhere,
    ...(excludeRequestId ? { requestId: { not: excludeRequestId } } : {}),
  },
  select: {
    requestId: true,
    request: { select: { docNumber: true, carRequest: { select: { startDate: true, endDate: true, sharedTripId: true } } } },
  },
});
// A late car only poisons the near future. Refuse a window that starts inside
// the hand-back buffer (default 30 min, bufferMinutes() :302); tomorrow's
// booking is legitimate business and must stay bookable while today's car is out.
const bufferMs = (await this.bufferMinutes()) * 60_000;
if (held && start.getTime() < now.getTime() + bufferMs) {
  const own = excludeRequestId
    ? await this.prisma.carRequest.findUnique({ where: { requestId: excludeRequestId }, select: { sharedTripId: true } })
    : null;
  const heldGroup = held.request.carRequest?.sharedTripId ?? null;
  if (!own?.sharedTripId || own.sharedTripId !== heldGroup) {
    return {
      available: false,
      conflicts: [{
        requestId: held.requestId,
        sharedTripId: heldGroup,
        startDate: now,
        endDate: new Date(now.getTime() + bufferMs),
        request: { docNumber: '🏁 Still out — return overdue' },
      }],
    };
  }
}
```

  The buffer guard is not optional: without it the hold refuses *every* future
  window for that car, so a car 20 minutes late could not be booked for next
  week — the same over-blocking the ETA stretch exists to avoid. A hold that
  belongs to the caller's own `sharedTripId` is not a conflict (a convoy may
  still extend its own ride). The synthetic `conflicts[]` entry carries
  `requestId`, `startDate`, `endDate`, `sharedTripId` and `request.docNumber`
  because `assign()` reads `conflicts[0].startDate/endDate` for its 409 message
  (`:815`) and the picker form renders them.
- `cars.service.driverClash` — treat an overdue out-on-road assignment of the
  same driver as a clash (the driver is provably still driving).
- `fleet.service.listDrivers` (`:706`, status map `:746`) — its effective-status
  map turns a DB `ON_TRIP` with no live window into `AVAILABLE`. A held driver
  would read AVAILABLE on the Fleet page.
- `fleet.service.busyDriverIds` (`:685`) and the inline busy-driver list in
  `telegram-car-actions.service.ts:779` — both are window-only, so a held driver
  is offered for a new trip.

Acceptance: a held car reports `IN_USE` + `overdueReturn: true` in both fleet
endpoints, `checkAvailability` rejects a window starting within the hand-back
buffer (and still accepts a window for tomorrow), and a request submitted for the
same car now shows the "still out" conflict instead of "free".

### Step 4 — Telegram picker and assign guard

`telegram-car-actions.service.ts` (assign vehicle list, ~`:714`):

1. Split the list: selectable = `AVAILABLE` and not held; held vehicles are
   listed separately as `🏁 9F1213 — still out (return overdue)`, not selectable.
2. `cars.service.assign()` — before the overlap check, reject with
   `ConflictException('Vehicle is still out on an overdue trip — close that trip first')`
   when `outOnRoadWhere` matches the vehicle.
3. `startTrip()` already rejects released assignments; no change.

4. Repeat the hold check **inside** `assign()`'s transaction, beside the
   existing overlap re-check: the pre-check is not race-safe if the janitor
   holds the car between the check and the insert.
5. The shared-trip path (`share: true`) deliberately skips the overlap block —
   the hold check must **not** be skipped there, the car is physically out.
6. `CarPanel.tsx:698` and `:772` filter `AVAILABLE || IN_USE` for the assign
   picker; add the hold flag so the web picker omits it too.
7. `reassign()` (`cars.service.ts:1613`, the panel's "Change vehicle /
   driver") must refuse a held ride as well. It only blocks a `STARTED` trip,
   then frees the old vehicle and **nulls every tap and both odometer readings**
   on the row — the exact evidence this feature depends on. Route the caller to
   the manual close.

Acceptance: `/assign CAR-…` cannot put a held car on a new request; API `assign`
returns 409 with the message above; the web picker does not list it.

### Step 5 — Admin manual close (backend)

New endpoint, reusing the audited odometer write:

```
POST /api/cars/requests/:requestId/trip/close      RBAC: cars.assign
body: { endOdoKm: number, reason: string, estimated?: boolean }
```

`cars.service.closeTripManually(requestId, dto, actor)`:

1. Load the assignment (+ `request`, `vehicle`, `trip`). Reject when already
   `COMPLETED`/released-and-closed (idempotency: 409).
2. Validate `endOdoKm >= (startOdoKm ?? 0)`; when `estimated` is true require
   `reason.trim().length >= 5`.
3. Extract the BACK-odometer write from `captureOdometer` into a private
   `writeOdometer(tx, assignment, { stage: 'BACK', km, source: 'ADMIN_MANUAL' })`
   so the audit stays `CAR_ODOMETER_RECORDED` with `{ stage: 'BACK', km,
   source: 'ADMIN_MANUAL', estimated }` and the photo fields are left untouched.
   `captureOdometer` keeps calling the same helper (no behaviour change).
   The helper takes an optional photo (a manual close usually has none) and
   never calls `telegram.manualAck` — that is what stamps the driver's tap.
4. One transaction:
   - `carAssignments`: `endOdoKm`, `endOdoAt = now` (only when missing),
     `releasedAt = now`, `estimatedReturnAt = null`.
     **Do not set `driverBackAtOfficeAt`** — that column means "the driver
     tapped 🏁", and it feeds the driver discipline report and the trip chips.
     Faking it hides exactly the behaviour this feature exists to expose.
   - `carTrips` (when a row exists): extract the trip-row close-out from
     `completeTrip` (`:2414`, body `:2433–2452`) into a private
     `closeTripRow(tx, trip, km)` and call it from both entry points;
     `completeTrip` keeps its `STARTED` guard (`:2420`), its messages and its
     `TRIP_COMPLETED` bell. Copying the body instead would let the two writers
     drift.
   - `vehicles`: `currentMileage = Math.max(vehicle.currentMileage ?? 0,
     endOdoKm)` — never lower the fleet number, the rule `captureOdometer`
     already applies (`:1037`). `status = AVAILABLE` only when
     `tx.carAssignment.count({ where: { vehicleId, id: { not: id },
     releasedAt: null } }) === 0`. (`otherLiveHolders()` is private to
     `TripRemindersService`, `trip-reminders.service.ts:417` — not reachable
     from `CarsService`.)
   - `drivers`: `AVAILABLE` only when no other live assignment holds them.
   - `carRequests` + `requestDocuments`: `COMPLETED`.
   - Leave `driverNotedAt` / `driverArrivedAt` untouched (real taps).
5. Audit `CAR_TRIP_MANUALLY_CLOSED` `{ endOdoKm, estimated, reason, minutesOver,
   closedById, photo: false }`; the reading itself keeps its
   `CAR_ODOMETER_RECORDED` audit with `source: 'ADMIN_MANUAL'`.
6. Notify: requester `TRIP_COMPLETED` ("closed by Administration after the
   return window"), driver's Telegram (`✅ … closed by Administration — return
   341,651 km`), and mirror to admins who hold `cars.assign`. Send once per
   close (the endpoint is idempotent, see step 1).

Acceptance: closing CAR-202611-0039-like data writes exactly one new BACK
odometer audit, sets `endOdoKm` / `endOdoAt` / `releasedAt`, leaves
`driverBackAtOfficeAt` **null** (step 4 — the driver never tapped, and the
discipline report must keep showing that), sets vehicle `AVAILABLE` with
`currentMileage = 341651`, and re-closing returns 409.

### Step 6 — Admin UI (trip panel)

`frontend/src/components/CarPanel.tsx`, next to `OdometerBox`:

1. When `!driverBackAtOfficeAt && !releasedAt` and the **effective end**
   (`estimatedReturnAt ?? endDate`) `< now` (and ride evidence), show a red
   `Overdue return` chip in the driver lane and a **Close trip manually**
   button.
2. Modal:
   - Return odometer (km) — prefilled from `endOdoKm` when present.
   - Checkbox **"Return km is an estimate / could not be read"** → shows a
     required Reason field.
   - Shows the current start km and computed distance.
   - Confirm → `POST …/trip/close` only. Do **not** post the odometer first:
     `captureOdometer` (`:1021`) and `OdometerBox` (`OdometerBox.tsx:143`)
     both require a dashboard photo, so a km-only close would be rejected before
     the close ever ran. `closeTripManually` writes the reading itself; the photo can be
     attached afterwards through `OdometerBox` when the driver sends it.
     Toast, then `onSaved`.
3. Reuse `OdometerBox` for later correction of the km; no second form.
4. Fleet list and requester fleet card: render `overdueReturn` as a red
   "Overdue return" tag beside the `IN_USE` badge (no new badge enum value, so
   nothing else has to learn a new status).

Acceptance: the button is absent for closed trips, disabled while submitting,
and the km field rejects values below the start km before the request is sent.

---

## 6. Data model

No migration required. Uses existing columns:
`startOdoAt`, `endOdoAt`, `driverArrivedAt`, `driverBackAtOfficeAt`,
`releasedAt`, `estimatedReturnAt`, and `audit_logs` (`recordId` is `text`).

Optional (only if the 12 h audit/notification lookups prove slow):
add `overdueHeldAt` / `overdueAlertedAt` to `CarAssignment`. Plan assumes **not
needed** — both throttles reuse `audit_logs` / `notifications`, as the current
code already does.

---

## 7. Edge cases

| Case | Handling |
| --- | --- |
| Back tapped, return km missing | Complete (car is back). `odometerMissingNudge` already asks Admin for the km; OdometerBox allows entry. |
| Back tapped **after** an admin manual close | Back tap on a released row records the BACK reading (existing `captureOdometer` path) and audits `DRIVER_RETURNED`; it must not re-open the request. |
| Driver sends an ⏰ ETA | `effectiveEnd` keeps the car held until the ETA; after it, the hold applies anyway (now indefinite). |
| Shared / convoy ride | Hold the vehicle; the group branch still runs **before** the hold (Step 1.2), so a partner row closes with its group instead of being held for a Back stamp it will never get. A member with a live partner is never closed. |
| Driver has no Telegram | Admin alert says "call the driver"; no driver nudge. |
| Trip row exists and is `STARTED` | Already excluded from the janitor; the hold and escalation cover it. |
| Ride never happened (no Ready, no km, no trip) | Released as today (`CAR_TRIP_WINDOW_RELEASED`), request back to `APPROVED`. |
| Multi-day overdue (car missing / accident) | Stays `IN_USE`, admin alert repeats every 12 h (daily after 25 h), day-end digest lists it; Admin must close with a reason. |
| Admin uses **Release** on an out-on-road ride | Must be refused. Today `release()` only blocks a `STARTED` trip; releasing sets the request back to `APPROVED` with the car unlinked, which also **wipes every odometer field** on the next `assign()` (the upsert nulls `startOdo*/endOdo*`), and `expireStaleRequests` (window +2 h) then cancels the request as unserved. Guard `release()` with the same ride-evidence test and point the caller at the manual close. |
| Manual close while a `car_trips` row is `STARTED` | Close through `completeTrip` semantics so the trip row, `vehicle.currentMileage` and the completion bell are not written twice. |

---

## 8. Test plan

Unit / integration (`backend/test`, run with `node -r ts-node/register/transpile-only`).
`backend/package.json:10` lists every test file explicitly, so the new
`test/overdue-return.test.ts` must be appended to that `test` script — otherwise
`npm test` silently skips it.

1. New `test/overdue-return.test.ts`:
   - janitor holds when `driverArrivedAt` set and no Back (no release, no
     COMPLETED, vehicle `IN_USE`, one `CAR_OVERDUE_RETURN_HELD` audit);
   - janitor still finalises when `driverBackAtOfficeAt` set;
   - janitor still releases when there is no ride evidence;
   - `escalateOverdueRunning`: driver nudge at +30 min, admin notification only
     at +2 h, throttle holds for 12 h;
   - `closeTripManually`: writes BACK km + audit, completes, frees vehicle and
     driver, notifies requester/driver, second call 409, estimate without reason
     rejected, km below start rejected.
2. Extend `test/car-odometer.test.ts`: `captureOdometer` still writes the same
   audit and still stamps the driver stage after the shared `writeOdometer`
   extraction; a manual close writes the km with no photo and sets **no**
   `driverBackAtOfficeAt`.
3. Extend `test/car-lifecycle.test.ts`: fleet + requester fleet report
   `IN_USE` / `overdueReturn` for a held assignment; the 30-minute
   `renormalizeVehicleStatuses` pass leaves it `IN_USE`; `checkAvailability`
   rejects a window inside the buffer and allows tomorrow; `assign` returns 409
   (also with `share: true`); `release()` is refused while evidence exists.

Checks before commit:

- `npx tsc -p backend/tsconfig.json --noEmit` (in `node:20-alpine`, host has no Node);
- `npm test` in `backend` (after adding the new file to the script at
  `package.json:10`);
- `npm run build` in `frontend` (typecheck + bundle).

Manual verification on the testing stack (`:8030`):

1. Seed a request that ended 3 h ago, Ready tapped, no Back, no trip row.
2. Confirm: request stays `IN_PROGRESS`, car `IN_USE` + `Overdue return`, other
   request cannot take the car (API 409 + Telegram list), driver nudged, admin
   alert after the +2 h threshold.
3. Close it in the panel with return km → odometer, statuses, notices all
   correct; car bookable again.

---

### Existing tests that will change

- `backend/test/cars-fixes.test.ts:819` — "acknowledged expired trip →
  COMPLETED …" now expects a hold (no COMPLETED, vehicle stays `IN_USE`,
  `CAR_OVERDUE_RETURN_HELD` audit, no requester notice).
- `backend/test/car-lifecycle.test.ts:304` — "janitor auto-close keeps a car
  IN_USE when another live trip holds it" asserts the request still completes;
  it must assert the hold instead.

Both encode the behaviour this feature removes, so they are updated in the same
commit; no other suite touches `releaseExpired`.

## 9. Rollout

1. **Steps 1–6 are a single release — that is the deploy gate.** The hold
   (Step 1) and the manual close (Steps 5–6) are two halves of one behaviour
   change: a held car whose trip cannot be closed has no exit (the plan now
   refuses `release()` and `reassign()` on it). The escalation copy (Step 2) and
   the badge/picker readers (Steps 3–4) belong to the same change. Land them in
   one commit and deploy that commit; **never deploy the hold on its own** and
   add the close in a later release.
2. `NO_PULL=1 bash scripts/server/deploy-prod.sh`; verify `BUILD_COMMIT` matches
   the commit on both images and `:80` returns 200.
3. Keep the old auto-complete path for "no ride evidence" only; no feature flag
   needed.
4. Watch the first real late return **after** that deploy: the request stays
   `IN_PROGRESS`, the car reads `IN_USE` + "Overdue return" in both fleets, a new
   booking inside the buffer is refused, the +2 h admin alert lands, and the trip
   closes from the panel with the return km.
5. After a week, review: number of held trips, admin close latency, any car held
   > 24 h (should be zero without an admin reason).

No backfill is needed: production has **0** assignments matching the hold test
(query run 18 Nov 2026: `releasedAt is null AND driverBackAtOfficeAt is null AND
endDate < now − 15 min`). The first row that would have been auto-closed after
the deploy is the first one held.

---

## 10. Review against current code (18 Nov 2026)

Checked against `main@7a1bd90` (the source files are unchanged since `6440a88`;
the three commits after it are docs-only). These are the places where the first
draft of this plan would have collided with existing logic.

| # | Conflict found | Where | Resolution (now in the steps) |
| --- | --- | --- | --- |
| 1 | Self-heal frees the held car every 30 min (`hasLive` ignores held rows) | `trip-reminders.service.ts:484 renormalizeVehicleStatuses`, `hasLive` `:496` | Step 1.5 — held assignment counts as live |
| 2 | The +2 h admin alert is swallowed by the existing 12 h `ESCALATED` throttle | `trip-reminders.service.ts:1265` | Step 2.2 — separate marker, two stages |
| 3 | `release()` on an out-on-road ride → `APPROVED` → `expireStaleRequests` cancels it 2 h later | `cars.service.ts:1832 release` (`STARTED` guard `:1849`), `trip-reminders.service.ts:619` | §7 edge case + guard |
| 4 | `assign()` upsert wipes `startOdo*/endOdo*/driver*At` on a released row | `cars.service.ts:841–857` | Same guard: no release while ride evidence exists |
| 5 | `captureOdometer` requires a photo; `manualAck('returned')` fakes the driver's Back tap | `cars.service.ts:1021, 1072–1075` | Step 5.4 — own write, no `driverBackAtOfficeAt` |
| 6 | `requesterFleetOverview` would still show AVAILABLE: `lateEnd` is in the past | `cars.service.ts:403–430` (`coversNow` `:420`) | Step 3 — `coversNow` forced by the hold |
| 7 | `overlaps()` callers read `conflicts[0].startDate/endDate` | `cars.service.ts:540, 815` | Step 3 — synthetic conflict carries the full shape |
| 8 | `dayEndDigest` only lists `APPROVED`/`COMPLETED` and `STARTED` trips → held rides vanish and the "auto-closed" bucket goes empty | `trip-reminders.service.ts:863` (`noBack` `:879`) | Step 2.6 + a third bucket |
| 9 | Telegram picker allows `IN_USE` and filters only by window overlap; a held car is listed | `telegram-car-actions.service.ts:714` | Step 4.1 |
| 10 | Web picker allows `IN_USE` | `CarPanel.tsx:698, 772` | Step 4.6 |
| 11 | `driverClash` is window-only, so a held driver is free for a new window | `cars.service.ts:618` | Step 3 union |
| 12 | `completeTrip` requires a `STARTED` trip row, so it cannot close the no-trip rides this feature is about | `cars.service.ts:2414`, guard `:2420` | Step 5 — new endpoint, reuse only the trip-row body |
| 13 | Faking `driverBackAtOfficeAt` would hide the miss from the discipline report | `fleet.service.ts:964 driverMisses`, `missedBack` `:1018` | Step 5.4 — leave the stamp null |
| 14 | `freeOrphanedDrivers` keeps the driver `ON_TRIP` while the request is `IN_PROGRESS` | `trip-reminders.service.ts:454` | No change needed (verified) |
| 15 | `escalateUnacknowledged` fires only when `driverNotedAt = null` | `trip-reminders.service.ts:96` | No change needed (verified) |
| 16 | `startPassedNudge` skips requests with a live assignment | `trip-reminders.service.ts:526` | No change needed (verified) |
| 17 | **Change vehicle/driver** is allowed on an out-on-road ride and frees the old car, nulls every tap and both odometers | `cars.service.ts:1613 reassign` (nulls `:1746–1754`) | Step 4.7 — refuse it while ride evidence exists |
| 18 | Driver list turns a held driver into `AVAILABLE` (window-only derivation) | `fleet.service.ts:706 listDrivers` (map `:746`) | Step 3 — hold union |
| 19 | Both driver-busy lists are window-only, so a held driver is offered | `fleet.service.ts:685`, `telegram-car-actions.service.ts:779` | Step 3 — hold union |
| 20 | Two existing tests assert the old auto-complete behaviour | `cars-fixes.test.ts:819`, `car-lifecycle.test.ts:304` | Update them in the same commit (behaviour change is the point) |

Not inspected in this pass: the mobile/Telegram **requester** fleet card renderer
and the PDF/print views — both read the same `requesterFleetOverview` payload, so
they inherit the fix, but their rendering of `overdueReturn` is unverified.

## 11. Open questions

1. Should a Back tap with a return km **lower** than the departure km be blocked
   (today it is accepted and produces a negative distance)? Not part of this plan.
2. Should the fleet dashboard get an explicit "Overdue returns" widget, or is
   the notification + red tag enough for now?
3. For a car held over 24 h, should the vehicle be flagged `UNDER_MAINTENANCE`
   automatically after the admin close? Current plan leaves the status to Admin.
4. `adminCancelApproved()` can already cancel a held `IN_PROGRESS` ride (trip not
   `STARTED`), which frees the car and closes the request CANCELLED. That is a
   legitimate "the ride never happened" override with an audit trail; the plan
   leaves it, but the UI should warn that the return reading will be lost.
5. Should the Telegram driver card keep the ⏰ ETA button after the hold starts?
   It still works (`setEstimatedReturn` accepts an `IN_PROGRESS` ride) and pushes
   the admin alert later, which is useful for a long delay.
