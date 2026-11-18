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

`releaseExpired()` (`backend/src/cars/trip-reminders.service.ts:204`) decides by
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
4. Administration can close the trip manually with the return odometer, and that
   close is audited and notified exactly like a driver Back tap.

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
| Window ended + 15 min, ride evidence exists, no Back tap | **Do not close.** Assignment stays live, vehicle stays `IN_USE`, badge shows **Overdue return**, driver nudged (Telegram). |
| Overdue by ≥ 2 h | Admin alert: in-app notification + Telegram mirror — "manual close needed". Repeats at most every 12 h. |
| No ride evidence at all (no Ready, no departure km, no STARTED trip) | Release as today: vehicle + driver back to pool, request `APPROVED`. |
| Admin manual close | Return km (or explicit estimate + reason) → audited BACK odometer → trip/request `COMPLETED` → car freed → requester + driver notified. |

Definitions:

- **Ride evidence** = `startOdoAt != null` **or** `driverArrivedAt != null`
  **or** `trip.status = 'STARTED'`. Ready alone is enough: the driver said the
  car left the office.
- **Overdue** = `releasedAt = null` and `driverBackAtOfficeAt = null` and
  `endDate < now`, with ride evidence.

---

## 4. Code map (current)

| Area | File / symbol |
| --- | --- |
| Janitor | `backend/src/cars/trip-reminders.service.ts:204 releaseExpired`, cron `0 */30 * * * *`, `RELEASE_GRACE_MS = 15 min` |
| Driver nudge + admin escalation | same file `:1227 escalateOverdueRunning`, hourly at `:15`, 12 h notification throttle |
| Odometer-missing nudge | same file `:785 odometerMissingNudge`, hourly at `:20` (already flags a Back tap without return km) |
| Fleet badge (admin) | `backend/src/fleet/fleet.service.ts:512` `startedTrips` → `IN_USE` |
| Fleet badge (requester) | `backend/src/cars/cars.service.ts:405` `startedTrips` in `requesterFleetOverview` |
| Vehicle conflict check | `backend/src/cars/cars.service.ts:533 overlaps`, plus `driverClash` (`:617`) |
| Telegram assign picker | `backend/src/cars/telegram-car-actions.service.ts:714` (status `AVAILABLE` / `IN_USE`) |
| Driver Back tap | `backend/src/cars/cars.service.ts captureOdometer` (writes BACK, sets `driverBackAtOfficeAt`, audits `CAR_ODOMETER_RECORDED`) |
| Admin "complete trip" | `backend/src/cars/cars.service.ts completeTrip` — requires an existing `STARTED` trip, so it cannot close today's no-trip rides |
| Admin odometer UI | `frontend/src/components/OdometerBox.tsx` (record/edit both stages, `canManage`), used in `CarPanel.tsx:500` |
| Trip panel | `frontend/src/components/CarPanel.tsx` |

---

## 5. Implementation steps

### Step 1 — Janitor holds instead of closing

`trip-reminders.service.ts`

1. Extend the `releaseExpired` query `include` with `trip: { select: { status: true } }`
   (the query already filters `trip` to `null`/`NOT_STARTED`, so a STARTED trip
   never reaches the loop).
2. Insert a hold branch **before** the shared-trip and auto-complete branches:

```ts
const outOnRoad =
  a.startOdoAt != null || a.driverArrivedAt != null || a.trip?.status === 'STARTED';

if (outOnRoad && !a.driverBackAtOfficeAt) {
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

3. `auditHeldOnce` mirrors `auditLogCreateSafe` usage: write
   `CAR_OVERDUE_RETURN_HELD` with `{ vehicleId, driverId, endDate, minutesOver }`
   only when no such audit exists for the request in the last 12 h (same throttle
   style as `escalateOverdueRunning`).
4. Do **not** send a requester notification here (the existing "auto-closed"
   notice disappears naturally; the trip stays open in their view).

Acceptance: for a fixture like CAR-202611-0039 the request stays `IN_PROGRESS`,
`releasedAt` stays `null`, vehicle status is `IN_USE`, one audit row is written,
and nothing is sent to the requester.

### Step 2 — Escalation: driver nudge from +15 min, admin alert at +2 h

`escalateOverdueRunning` already selects exactly the rows the janitor now holds
(`releasedAt = null`, `driverBackAtOfficeAt = null`, `endDate < now`), so it
becomes the single overdue authority:

1. Keep the driver Telegram nudge (hourly). Add a cap: skip nudges after
   `overMins > 24 * 60` (the daily digest covers multi-day cases).
2. Admin notification only when `overMins >= 120` (the +2 h point), still
   throttled to one per request per 12 h.
3. Update the copy to match the new flow:

```
title: 🏁 Return overdue — CAR-… (2h 15m)
body : Naing Naing Tun has not tapped "Back at Office". 9F1213 is still held
       and cannot be assigned. Close the trip manually with the return km
       from the request page (Cars → request → Odometer / Close trip).
```

4. Mirror the same line to Administration's Telegram (same pattern as
   `notifyReadyToAssign`'s `telegram.mirrorToUser` loop).
5. Keep `dayEndDigest` unchanged, but rename its "auto-closed" bucket to
   "overdue, still open" once Step 1 lands (it reads `REQUEST_AUTO_COMPLETED`
   audits; adjust the query to count `CAR_OVERDUE_RETURN_HELD` instead).

Acceptance: with `endDate = now − 3 h`, one admin notification + one Telegram
mirror per 12 h, driver nudge hourly; with `endDate = now − 30 min`, driver
nudge only.

### Step 3 — Badge: "departure recorded, return missing" holds the car

Add one shared predicate so the four readers cannot drift:
`backend/src/cars/overdue.util.ts`

```ts
export const outOnRoadWhere = {
  releasedAt: null,
  driverBackAtOfficeAt: null,
  endOdoAt: null,
  OR: [{ driverArrivedAt: { not: null } }, { startOdoAt: { not: null }, }],
} as const;

export function isOutOnRoad(a: {
  releasedAt: Date | null; driverBackAtOfficeAt: Date | null;
  endOdoAt: Date | null; driverArrivedAt: Date | null; startOdoAt: Date | null;
}): boolean { ... }
```

Then replace the `startedTrips` queries with an OR of both holds:

- `fleet.service.ts:512` (`listVehicles`) — union `STARTED` trips and
  `outOnRoadWhere`; the row already maps to `IN_USE`. Add
  `overdueReturn: boolean` to the returned row.
- `cars.service.ts:405` (`requesterFleetOverview`) — same union, keep
  `effectiveEnd` so an ETA still stretches the coverage; add `overdueReturn`.
- `fleet.service.ts:734` (busy/availability maps) — same union.
- `cars.service.ts overlaps()` — after the ETA-stretched conflict filter, add:

```ts
const held = await this.prisma.carAssignment.findFirst({
  where: { vehicleId, ...outOnRoadWhere },
  select: { requestId: true },
});
if (held) return {
  available: false,
  conflicts: [{ requestId: held.requestId, request: { docNumber: '🏁 Still out — return overdue' }, ... }],
};
```

  This is what stops a new booking that starts *after* the planned end.
- `cars.service.driverClash` — treat an overdue out-on-road assignment of the
  same driver as a clash (the driver is provably still driving).

Acceptance: a held car reports `IN_USE` + `overdueReturn: true` in both fleet
endpoints, `checkAvailability` rejects any window that starts now, and a request
submitted for the same car shows the "still out" conflict instead of "free".

### Step 4 — Telegram picker and assign guard

`telegram-car-actions.service.ts` (assign vehicle list, ~`:714`):

1. Split the list: selectable = `AVAILABLE` and not held; held vehicles are
   listed separately as `🏁 9F1213 — still out (return overdue)`, not selectable.
2. `cars.service.assign()` — before the overlap check, reject with
   `ConflictException('Vehicle is still out on an overdue trip — close that trip first')`
   when `outOnRoadWhere` matches the vehicle.
3. `startTrip()` already rejects released assignments; no change.

Acceptance: `/assign CAR-…` cannot put a held car on a new request; API `assign`
returns 409 with the message above.

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
4. One transaction:
   - `carAssignments`: `endOdoKm`, `endOdoAt = now` (only if missing),
     `driverBackAtOfficeAt = now`, `releasedAt = now`, `estimatedReturnAt = null`.
   - `carTrips` (if a row exists): `status = COMPLETED`, `endMileage = endOdoKm`,
     `completedAt = now`, `remarks` unchanged.
   - `vehicles`: `currentMileage = endOdoKm`; `status = AVAILABLE` only when no
     other live assignment holds it (`otherLiveHolders`, same rule as the janitor).
   - `drivers`: `AVAILABLE` only when no other live assignment holds them.
   - `carRequests` + `requestDocuments`: `COMPLETED`.
5. Audit `CAR_TRIP_MANUALLY_CLOSED` `{ endOdoKm, estimated, reason, minutesOver,
   closedById }`.
6. Notify: requester `TRIP_COMPLETED` ("closed by Administration after the
   return window"), driver's Telegram (`✅ … closed by Administration — return
   341,651 km`), and mirror to admins who hold `cars.assign`.

Acceptance: closing CAR-202611-0039-like data writes exactly one new BACK
odometer audit, sets `driverBackAtOfficeAt`/`releasedAt`, sets vehicle
`AVAILABLE` with `currentMileage = 341651`, and re-closing returns 409.

### Step 6 — Admin UI (trip panel)

`frontend/src/components/CarPanel.tsx`, next to `OdometerBox`:

1. When `!driverBackAtOfficeAt && !releasedAt && endDate < now` (and ride
   evidence), show a red `Overdue return` chip in the driver lane and a
   **Close trip manually** button.
2. Modal:
   - Return odometer (km) — prefilled from `endOdoKm` when present.
   - Checkbox **"Return km is an estimate / could not be read"** → shows a
     required Reason field.
   - Shows the current start km and computed distance.
   - Confirm → `POST …/odometer` (BACK, if not yet recorded) then
     `POST …/trip/close`; toast, `onSaved`.
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
| Shared / convoy ride | Hold the vehicle; group completion logic is unchanged. A member with a live partner is never closed. |
| Driver has no Telegram | Admin alert says "call the driver"; no driver nudge. |
| Trip row exists and is `STARTED` | Already excluded from the janitor; the hold and escalation cover it. |
| Ride never happened (no Ready, no km, no trip) | Released as today (`CAR_TRIP_WINDOW_RELEASED`), request back to `APPROVED`. |
| Multi-day overdue (car missing / accident) | Stays `IN_USE`, admin alert repeats every 12 h, day-end digest lists it; Admin must close with a reason. |

---

## 8. Test plan

Unit / integration (`backend/test`, run with `node -r ts-node/register/transpile-only`):

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
   audit after the shared `writeOdometer` extraction.
3. Extend `test/car-lifecycle.test.ts`: fleet + requester fleet report
   `IN_USE` / `overdueReturn` for a held assignment; `checkAvailability` rejects
   a window starting now; `assign` returns 409.

Checks before commit:

- `npx tsc -p backend/tsconfig.json --noEmit` (in `node:20-alpine`, host has no Node);
- `npm test` in `backend` (as listed in `package.json`);
- `npm run build` in `frontend` (typecheck + bundle).

Manual verification on the testing stack (`:8030`):

1. Seed a request that ended 3 h ago, Ready tapped, no Back, no trip row.
2. Confirm: request stays `IN_PROGRESS`, car `IN_USE` + `Overdue return`, other
   request cannot take the car (API 409 + Telegram list), driver nudged, admin
   alert after the +2 h threshold.
3. Close it in the panel with return km → odometer, statuses, notices all
   correct; car bookable again.

---

## 9. Rollout

1. Land Steps 1–3 first (backend behaviour + badges), deploy, watch one real
   late return. Steps 5–6 (manual close UI/API) must ship **with** Step 1 —
   without a manual close the held car has no exit.
2. `NO_PULL=1 bash scripts/server/deploy-prod.sh`; verify `BUILD_COMMIT` matches
   the commit on both images and `:80` returns 200.
3. Keep the old auto-complete path for "no ride evidence" only; no feature flag
   needed.
4. After a week, review: number of held trips, admin close latency, any car held
   > 24 h (should be zero without an admin reason).

---

## 10. Open questions

1. Should a Back tap with a return km **lower** than the departure km be blocked
   (today it is accepted and produces a negative distance)? Not part of this plan.
2. Should the fleet dashboard get an explicit "Overdue returns" widget, or is
   the notification + red tag enough for now?
3. For a car held over 24 h, should the vehicle be flagged `UNDER_MAINTENANCE`
   automatically after the admin close? Current plan leaves the status to Admin.
