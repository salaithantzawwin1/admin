# Cron Jobs — Audit & Recommendations (2026-09-25)

Every `@Cron` in the backend, what it does, whether its frequency fits the
decision it drives, and which SSE event it should publish so open UI tabs
refresh immediately. Ground rule from the architecture discussion:

- **Clock-driven state** → cron (the *time* is the trigger).
- **Human/action-driven state** → publish an event at the action site (webhook, controller), never wait for the next tick.
- **Granularity rule**: if the tick's output changes what a user can *do* in the UI (e.g. assign a car), tick at least as fast as users can act on it — otherwise the cron decides, not the user.
- Every tick that *changes* something should `events.publish(...)` so the Fleet/Car screens update without waiting for the 15s polling fallback.

| # | Job | Location | Schedule | Verdict | Event to publish |
|---|-----|----------|----------|---------|------------------|
| 1 | `syncAbsenceStatuses` — ON_LEAVE at leave-window start, AVAILABLE at end | fleet.service.ts | **every 5 min** (`EVERY_5_MINUTES`) | ✅ correct — was hourly, caused 08:00–12:30 morning leave to restore at 13:05. 5 min matches office pace. | `driver.updated` (done — flips > 0 only) |
| 2 | `lifecycleCron` — SCHEDULED→PUBLISHED→EXPIRED announcements | announcements.service.ts | hourly at :05 | ✅ fine — announcement visibility ±30 min is not actionable; hourly is already generous. | `request.updated`-style signal is unnecessary; pages refetch on their own visit. Skip. |
| 3 | `daily` trip reminders — morning assignment digest to drivers | trip-reminders.service.ts | daily 07:30 | ✅ fine — deliberately "in time for the morning's trips". | n/a (Telegram outbound, not UI state) |
| 4 | `escalateUnacknowledged` — driver never tapped Noted after window start | trip-reminders.service.ts | every 30 min | ✅ fine — escalation cadence, not a UI gate; first nudge within 30 min is acceptable for an offline-aware workflow. | `assignment.updated` when it escalates (nice-to-have) |
| 5 | `releaseExpired` — mark ended assignments done so availability is truthful | trip-reminders.service.ts | every 30 min | ⚠️ **keep 30 min, but note**: the *availability correctness* no longer depends on it — cars.service availability checks exempt assignments whose driver tapped Back at Office at query time. This job is now housekeeping for the list views. | `driver.updated` + `assignment.updated` on change |
| 6 | `escalateOverdueRunning` — window ended, no Back at Office | trip-reminders.service.ts | hourly at :15 | ✅ fine — deliberately patient (idempotent, 12h dedup), human phone-call territory. | n/a |
| 7 | `lowStockCron` — LOW_STOCK alerts + reorder suggestions | inventory.service.ts | daily 08:00 | ✅ fine — stock does not change by itself; a daily digest is the right shape. | n/a |
| 8 | `autoCompleteEndedCron` — mark ended meetings done | meeting-rooms.service.ts | every 30 min | ✅ fine — calendar/list housekeeping. | `request.updated` for open meeting tabs (nice-to-have) |
| 9 | `unassignedMeetingReminderCron` — approved meetings without a room 24h+ | meeting-rooms.service.ts | daily 08:30 | ✅ fine — consolidated daily reminder by design. | n/a |
| 10 | `archiveStaleCancelled` — soft-archive CANCELLED > 30 days | workflow.service.ts | hourly | ✅ fine — invisible background hygiene; even daily would do. | n/a (archived rows leave lists; users refetch on visit) |
| 11 | `escalateStaleRequests` — L1 pending > 72h → MANAGEMENT | workflow.service.ts | hourly | ✅ fine — escalation is a courtesy nudge, hourly cadence matches office review rhythm. | `notification` already fires via notifyMany when escalation happens |

## Summary

- **Changed this round**: `syncAbsenceStatuses` hourly → every 5 minutes (the only cron whose output gates a user decision — assign-ready drivers), now publishing `driver.updated`.
- **Everything else**: keep as-is. The audit found no job whose frequency mismatched its purpose; reminder/escalation jobs are deliberately patient and housekeeping jobs are invisible.
- **Live updates**: no cron needs to run faster for UI freshness — that is now the SSE channel's job (`GET /events`), with 15s polling kept as fallback. Cron ticks that change state publish signals so open tabs refetch immediately.

## Multiple-replica caveat

All crons + the SSE broker are in-process (single backend container). If the
backend ever scales to replicas: move `publish()` fan-out to Redis pub/sub and
run crons with a distributed lock (e.g. single leader pod or a `cron.lock`
table row with `FOR UPDATE SKIP LOCKED`). Documented in events.service.ts.
