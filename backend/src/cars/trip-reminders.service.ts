import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { PermissionsService } from '../auth/permissions.service';
import { yangonShort, yangonClock } from '../util/yangon-time';

const REMINDER_TYPE = 'REMINDER' as never; // existing NotificationType enum value

/**
 * Reminders for upcoming car trips (Plan §20): when a week's worth of requests
 * exists, requesters get a bell reminder 24h before their trip starts.   * Idempotent — at most one REMINDER per request (checked before sending).
 */
@Injectable()
export class TripRemindersService {
  private readonly logger = new Logger(TripRemindersService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private telegram: TelegramService,
    private permissions: PermissionsService,
  ) {}

  /** Send TRIP_REMINDER for APPROVED/IN_PROGRESS car requests starting within the next 24h. */
  async runOnce(): Promise<number> {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 3600 * 1000);

    const upcoming = await this.prisma.carRequest.findMany({
      where: {
        // base document status (single source of truth) — CarRequest.status is a mirror
        request: { status: { in: ['APPROVED', 'IN_PROGRESS'] as never } },
        startDate: { gte: now, lte: in24h },
        vehicleId: { not: null }, // assigned only — reminders start after Administration assigns a car
      },
      include: {
        request: { select: { id: true, docNumber: true, requesterId: true } },
        vehicle: { select: { vehicleNo: true, brandModel: true } },
        driver: { select: { name: true } },
      },
    });

    let sent = 0;
    for (const trip of upcoming) {
      // idempotency: skip if this request already got a reminder
      const existing = await this.prisma.notification.findFirst({
        where: { requestId: trip.requestId, type: REMINDER_TYPE },
        select: { id: true },
      });
      if (existing) continue;

      // same-day trips start in a few hours — "Tomorrow's" would be wrong for them
      const isSameDay = new Date(trip.startDate).toDateString() === now.toDateString();

      await this.notifications.notify({
        userId: trip.request.requesterId,
        type: REMINDER_TYPE,
        title: `${isSameDay ? 'Today' : 'Tomorrow'}'s trip — ${trip.request.docNumber}`,
        body: `Vehicle ${trip.vehicle?.vehicleNo ?? ''} (${trip.vehicle?.brandModel ?? ''})${trip.driver ? ` with driver ${trip.driver.name}` : ''} is arranged for your trip starting ${yangonShort(trip.startDate)}.`,
        link: `/requests/${trip.requestId}`,
        requestId: trip.requestId,
      });
      sent++;
    }
    return sent;
  }

  // twice hourly (:25/:55) — a single 07:30 tick died with the morning reboots
  // (no reminder ever sent since Sep 25); idempotent per request, so extra
  // sweeps are free and each request still gets at most one REMINDER
  @Cron('0 25,55 * * * *')
  async daily() {
    const sent = await this.runOnce();
    if (sent > 0) console.log(`[cars] sent ${sent} trip reminder(s)`);
  }

  /**
   * Driver-not-started escalation (Plan §22): an assignment whose trip window
   * has already begun but whose driver has never acknowledged it (no ✓ Noted)
   * — ping the driver directly on Telegram and raise it to Administration.
   * Idempotent per stage: at most one DRIVER_NUDGE per request per day
   * (recent one is re-sent as a Telegram nudge, not a fresh bell).
   */
  @Cron('0 */30 * * * *') // same cadence as releaseExpired — every 30 min
  async escalateUnacknowledged() {
    try {
      const now = new Date();
      // window started 15+ min ago and ends in the future (still relevant), or
      // started within the last 24h (covers overnight/late trips after the fact)
      const windowStart = new Date(now.getTime() - 24 * 3600 * 1000);

      const overdue = await this.prisma.carAssignment.findMany({
        where: {
          releasedAt: null,
          trip: null, // no CarTrip row at all == trip never started
          driverNotedAt: null, // the driver has not even tapped "✓ Noted" —
          // without this filter a driver who DID acknowledge (Noted/Arrived) but
          // has not started the trip yet got nagged + escalated every 30 minutes
          request: { carRequest: { startDate: { lte: new Date(now.getTime() - 15 * 60 * 1000), gte: windowStart } } },
        },
        include: {
          driver: { select: { id: true, name: true, telegramChatId: true } },
          vehicle: { select: { vehicleNo: true, brandModel: true } },
          request: {
            select: { docNumber: true, requester: { select: { fullName: true } }, carRequest: { select: { startDate: true, pickupLocation: true, destination: true } } },
          },
        },
      });

      for (const a of overdue) {
        if (!a.driver) continue; // defensive — assignment without a driver should not exist
        if (a.driverNotedAt || a.driverArrivedAt) continue; // acknowledged late/in between runs — skip (defensive second line)
        const cr = a.request.carRequest;
        const when = cr?.startDate ? yangonShort(new Date(cr.startDate)) : 'the scheduled time';
        const pickup = cr?.pickupLocation ?? '—';
        const dest = cr?.destination ?? '—';

        // 1) driver nudge — direct Telegram message to the driver's chat
        if (a.driver.telegramChatId) {
          await this.telegram.sendRaw(
            a.driver.telegramChatId,
            [
              `⏰ <b>Reminder — ${escapeHtml(a.request.docNumber)}</b>`,
              `Your trip started at ${escapeHtml(when)} but has not been acknowledged yet.`,
              ``,
              `📍 Pickup: ${escapeHtml(pickup)}`,
              `🗺 Destination: ${escapeHtml(dest)}`,
              ``,
              `Please open your assignment message and tap <b>"✓ Noted"</b> so Administration knows you are on it.`,
            ].join('\n'),
          ).catch(() => undefined);
        }

        // 2) Administration escalation — idempotent: at most one per request per day
        const recent = await this.prisma.notification.findFirst({
          where: {
            type: 'ESCALATED' as never,
            requestId: a.requestId,
            createdAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000) },
          },
          select: { id: true },
        });
        if (recent) continue;

        // RBAC-native: whoever can assign cars/trips gets the no-ack escalation
        const adminIds = await this.permissions.usersWithPermissions(['cars.assign']);
        const title = `⏰ Driver has not acknowledged — ${a.request.docNumber}`;
        const body = `${a.driver.name} has not tapped ✓ Noted for the trip that started ${when} (vehicle ${a.vehicle?.vehicleNo ?? '—'}). ${a.driver.telegramChatId ? 'Driver was reminded on Telegram.' : 'Driver has no Telegram link — reach them directly.'}`;
        await this.notifications.notifyMany(adminIds, {
          type: 'ESCALATED' as never,
          title,
          body,
          link: `/requests/${a.requestId}`,
          requestId: a.requestId,
        });
        await this.auditNudge(a.requestId, a.driver.name);
        this.logger.log(`escalated unacknowledged trip ${a.request.docNumber} (driver ${a.driver.name})`);
      }
    } catch (e) {
      this.logger.warn(`escalateUnacknowledged failed: ${(e as Error).message}`);
    }
  }

  private async auditNudge(requestId: string, driverName: string) {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'TRIP_DRIVER_NUDGED', module: 'CARS', recordId: requestId,
          newValue: { driver: driverName },
        },
      });
    } catch {
      /* audit must never break the escalation */
    }
  }

  /**
   * Auto-close: assignments whose request window ended with no recorded trip
   * activity keep the vehicle IN_USE forever. Two outcomes, chosen by whether
   * the driver ever acknowledged the ride:
   *  • Noted/Ready tapped → the trip HAPPENED — close it COMPLETED (the old
   *    code flipped these back to APPROVED, so finished rides reappeared in
   *    the "waiting for vehicle" list a day later and stayed there).
   *  • never acknowledged → the ride plausibly never happened — release the
   *    vehicle back to the pool and re-await assignment (APPROVED).
   * Both paths free the DRIVER too (the old path left them ON_TRIP forever).
   * Trips genuinely on the road past the window (trip STARTED) are left alone.
   */
  @Cron('0 */30 * * * *')
  async releaseExpired() {
    const now = new Date();

    const stuck = await this.prisma.carAssignment.findMany({
      where: {
        releasedAt: null,
        // link via requestId — carAssignment.carRequestId is not always set.
        // A ⏰ ETA past the planned end keeps the assignment out of the janitor
        // until the ETA passes (Back at Office remains the early exit).
        AND: [
          {
            OR: [
              { request: { carRequest: { endDate: { lt: now } } }, estimatedReturnAt: null },
              { estimatedReturnAt: { lt: now } },
            ],
          },
          { OR: [{ trip: null }, { trip: { status: 'NOT_STARTED' } }] },
        ],
      },
      include: {
        vehicle: { select: { vehicleNo: true } },
        request: { select: { docNumber: true, requesterId: true, carRequest: { select: { endDate: true } } } },
      },
    });

    for (const a of stuck) {
      const freedDriver = a.driverId
        ? [this.prisma.driver.update({ where: { id: a.driverId }, data: { status: 'AVAILABLE' } })]
        : [];
      if (a.driverNotedAt || a.driverArrivedAt) {
        // driver confirmed the ride → complete it, do NOT re-await a car
        await this.prisma.$transaction([
          this.prisma.carAssignment.update({ where: { id: a.id }, data: { releasedAt: now, estimatedReturnAt: null } }),
          this.prisma.vehicle.update({ where: { id: a.vehicleId }, data: { status: 'AVAILABLE' } }),
          ...freedDriver,
          this.prisma.carRequest.update({ where: { requestId: a.requestId }, data: { status: 'COMPLETED' } }),
          this.prisma.requestDocument.update({ where: { id: a.requestId }, data: { status: 'COMPLETED' } }),
        ]);
        // same audit + requester notice the Back-at-Office path writes
        await this.prisma.auditLog.create({
          data: {
            action: 'REQUEST_AUTO_COMPLETED', module: 'CARS', recordId: a.requestId,
            newValue: { reason: 'Window ended without "Back at Office" — auto-closed', auto: true },
          },
        }).catch(() => undefined);
        await this.prisma.notification.create({
          data: {
            userId: a.request.requesterId,
            type: 'TRIP_COMPLETED' as never,
            title: `✅ Trip completed — ${a.request.docNumber}`,
            body: 'The trip window ended, so the request was closed automatically.',
            link: `/requests/${a.requestId}`,
            requestId: a.requestId,
          },
        }).catch(() => undefined);
        // same Telegram mirror the Back-at-Office completion sends (best-effort)
        await this.telegram
          .mirrorToUser(a.request.requesterId, `✅ Trip completed — ${a.request.docNumber}`, 'The trip window ended, so the request was closed automatically.', `/requests/${a.requestId}`)
          .catch(() => undefined);
        console.log(`[cars] auto-COMPLETED ${a.request.docNumber} (driver acknowledged, window over)`);
      } else {
        // mirror the release on the car row and the base document (back to APPROVED,
        // awaiting a new assignment)
        await this.prisma.$transaction([
          this.prisma.carAssignment.update({ where: { id: a.id }, data: { releasedAt: now, estimatedReturnAt: null } }),
          this.prisma.vehicle.update({ where: { id: a.vehicleId }, data: { status: 'AVAILABLE' } }),
          ...freedDriver,
          this.prisma.carRequest.update({ where: { requestId: a.requestId }, data: { vehicleId: null, driverId: null, status: 'APPROVED' } }),
          this.prisma.requestDocument.update({ where: { id: a.requestId }, data: { status: 'APPROVED' } }),
        ]);
      }
    }
    if (stuck.length > 0) {
      console.log(`[cars] auto-released ${stuck.length} expired assignment(s): ${stuck.map((a) => a.request.docNumber).join(', ')}`);
    }
    await this.freeOrphanedDrivers();
    await this.renormalizeVehicleStatuses();
  }

  /**
   * Self-heal: drivers stuck ON_TRIP with no live IN_PROGRESS ride (leftovers
   * from the pre-fix cancel/auto-release paths, or manual edits). Available
   * again — a driver marked busy with nothing to drive is invisible to the
   * assign pickers. Runs at the tail of releaseExpired, never throws.
   */
  private async freeOrphanedDrivers() {
    try {
      const now = new Date();
      const stuckDrivers = await this.prisma.driver.findMany({
        where: {
          status: 'ON_TRIP',
          NOT: { carAssignments: { some: { releasedAt: null, request: { status: 'IN_PROGRESS' } } } },
        },
        select: { id: true, name: true },
      });
      for (const d of stuckDrivers) {
        await this.prisma.driver.update({ where: { id: d.id }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
        await this.prisma.auditLog.create({
          data: { action: 'DRIVER_AUTO_FREED', module: 'CARS', recordId: d.id, newValue: { reason: 'No active assignment — auto-freed by janitor cron' } },
        }).catch(() => undefined);
        this.logger.log(`freed orphaned ON_TRIP driver ${d.name}`);
      }
    } catch (e) {
      this.logger.warn(`freeOrphanedDrivers failed: ${(e as Error).message}`);
    }
  }

  /**
   * Self-heal for vehicles: a car whose DB status still says IN_USE but which
   * has no live claim on it (no active booking covering/after now, no STARTED
   * trip) is physically back in the pool — the flag is an artifact (e.g. a
   * release whose AVAILABLE write was lost, 2P2942 stuck BOOKED Oct 2-6).
   * Mirrors freeOrphanedDrivers: repairs the DB column so assignment pickers
   * and any other DB-status reader see the truth. Never throws.
   */
  private async renormalizeVehicleStatuses() {
    try {
      const now = new Date();
      const inUse = await this.prisma.vehicle.findMany({
        where: { status: 'IN_USE' },
        select: {
          id: true, vehicleNo: true,
          carRequests: { where: { request: { status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as never } } }, select: { startDate: true, endDate: true } },
          assignments: { where: { releasedAt: null, trip: { status: 'STARTED' } }, select: { id: true } },
        },
      });
      for (const v of inUse) {
        const hasLive = v.carRequests.some((b) => new Date(b.endDate) >= now) || v.assignments.length > 0;
        if (!hasLive) {
          await this.prisma.vehicle.update({ where: { id: v.id }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
          await this.prisma.auditLog.create({
            data: { action: 'VEHICLE_AUTO_FREED', module: 'CARS', recordId: v.id, newValue: { reason: 'Status said IN_USE with no live booking/trip — renormalized by janitor cron' } },
          }).catch(() => undefined);
          this.logger.log(`renormalized vehicle ${v.vehicleNo} IN_USE → AVAILABLE (no live booking/trip)`);
        }
      }
    } catch (e) {
      this.logger.warn(`renormalizeVehicleStatuses failed: ${(e as Error).message}`);
    }
  }

  /**
   * Expire forgotten requests: a car request whose window ended MORE than 24h
   * ago and that never got a vehicle (or never got approved) can no longer
   * happen — the rider forgot to cancel. Close it CANCELLED with an audit
   * trail and tell the requester, so Administration's waiting lists only ever
   * contain trips that can still be served. Assigned/STARTED rides are never
   * touched (those close via Back-at-Office / the trip form).
   */
  // twice hourly (:05/:35) instead of a single 07:00 tick — the box boots late
  // morning after power cuts, so a once-a-day 07:00 tick kept getting killed
  // before it ever ran; windows ended >24h then sat APPROVED forever
  // (CAR-202610-0007). Same 24h rule, just a cadence that survives reboots.
  @Cron('0 5,35 * * * *')
  async expireStaleRequests() {
    try {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
      const stale = await this.prisma.requestDocument.findMany({
        where: {
          docType: 'CAR_REQUEST',
          status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED'] as never },
          carRequest: { endDate: { lt: cutoff } },
        },
        select: { id: true, docNumber: true, status: true, requesterId: true },
        take: 100,
        orderBy: { updatedAt: 'asc' },
      });
      let expired = 0;
      for (const r of stale) {
        // an APPROVED request with a LIVE assignment belongs to the Back-at-Office
        // flow, not this one — skip it (defensive re-check inside the loop)
        if (r.status === 'APPROVED') {
          const live = await this.prisma.carAssignment.findFirst({ where: { requestId: r.id, releasedAt: null }, select: { id: true } });
          if (live) continue;
        }
        await this.prisma.$transaction([
          this.prisma.requestDocument.update({ where: { id: r.id }, data: { status: 'CANCELLED' } }),
          this.prisma.carRequest.update({ where: { requestId: r.id }, data: { status: 'CANCELLED' } }),
        ]);
        await this.prisma.auditLog.create({
          data: { action: 'REQUEST_AUTO_EXPIRED', module: 'CARS', recordId: r.id, newValue: { reason: 'Window ended >24h ago without approval/assignment — auto-expired', wasStatus: r.status } },
        }).catch(() => undefined);
        await this.prisma.notification.create({
          data: {
            userId: r.requesterId,
            type: 'CANCELLED' as never,
            title: `⌛ Request expired — ${r.docNumber}`,
            body: 'The trip window passed without the request being used, so it was closed automatically. Submit a new request if you still need the car.',
            link: `/requests/${r.id}`,
            requestId: r.id,
          },
        }).catch(() => undefined);
        await this.telegram
          .mirrorToUser(r.requesterId, `⌛ Request expired — ${r.docNumber}`, 'The trip window passed without the request being used, so it was closed automatically. /car နဲ့ အသစ်ပြန်တောင်းနိုင်ပါတယ်။', `/requests/${r.id}`)
          .catch(() => undefined);
        expired++;
      }
      if (expired > 0) this.logger.log(`auto-expired ${expired} stale car request(s) (window ended >24h ago)`);
    } catch (e) {
      this.logger.warn(`expireStaleRequests failed: ${(e as Error).message}`);
    }
  }

  /**
   * 17:30 Yangon day-end digest for Administration: every car assignment that
   * ended its window today without a "🏁 Back at Office" tap, split into
   * auto-closed (janitor completed them) vs mileage-open (trip STARTED —
   * awaiting Administration's mileage close-out). One message per cars.assign
   * holder with a Telegram chat; silent when there is nothing to report.
   */
  @Cron('0 30 17 * * *')
  async dayEndDigest() {
    try {
      const now = new Date();
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 17, 30)); // yesterday 17:30 UTC ≈ today 00:00 Yangon
      const assignments = await this.prisma.carAssignment.findMany({
        where: {
          request: { carRequest: { endDate: { gte: dayStart, lte: now } } },
          OR: [{ driverBackAtOfficeAt: null }, { driverBackAtOfficeAt: { gte: dayStart } }],
        },
        include: {
          driver: { select: { name: true } },
          vehicle: { select: { vehicleNo: true } },
          trip: { select: { status: true } },
          request: { select: { docNumber: true, status: true, carRequest: { select: { endDate: true } } } },
        },
      });
      const noBack = assignments.filter(
        (a) => !a.driverBackAtOfficeAt && a.request.carRequest && new Date(a.request.carRequest.endDate) <= now &&
          (!a.trip || a.trip.status === 'NOT_STARTED') && ['APPROVED', 'COMPLETED'].includes(a.request.status),
      );
      const mileageOpen = assignments.filter((a) => a.trip?.status === 'STARTED');
      if (noBack.length === 0 && mileageOpen.length === 0) return;
      const lines: string[] = ['📋 <b>Day-end — trips without "Back at Office"</b>'];
      if (noBack.length > 0) {
        lines.push('', '<b>🤖 Auto-closed (window ended, driver never tapped):</b>');
        for (const a of noBack) lines.push(`• ${escapeHtml(a.request.docNumber)} — ${escapeHtml(a.driver?.name ?? 'no driver')} · ${escapeHtml(a.vehicle?.vehicleNo ?? '—')} · ended ${fmtYgn(a.request.carRequest!.endDate)}`);
      }
      if (mileageOpen.length > 0) {
        lines.push('', '<b>🧮 Mileage open (trip STARTED — complete the trip form):</b>');
        for (const a of mileageOpen) lines.push(`• ${escapeHtml(a.request.docNumber)} — ${escapeHtml(a.driver?.name ?? '—')} · ${escapeHtml(a.vehicle?.vehicleNo ?? '—')}`);
      }
      lines.push('', '<i>Ask drivers to tap 🏁 Back at Office right when they return — the car frees instantly.</i>');
      const text = lines.join('\n');
      const adminIds = await this.permissions.usersWithPermissions(['cars.assign']);
      const admins = await this.prisma.user.findMany({
        where: { id: { in: adminIds }, telegramChatId: { not: null } },
        select: { telegramChatId: true },
      });
      for (const a of admins) {
        if (a.telegramChatId) await this.telegram.sendRaw(a.telegramChatId, text).catch(() => undefined);
      }
      this.logger.log(`day-end digest sent to ${admins.length} admin(s): ${noBack.length} auto-closed, ${mileageOpen.length} mileage-open`);
    } catch (e) {
      this.logger.warn(`dayEndDigest failed: ${(e as Error).message}`);
    }
  }

  /**
   * Shift-handover digest (17:00 Yangon — the day shift hands over): today's
   * remaining trips, what is on the road right now (⏰ delays flagged) and
   * vehicles blocked for service/inspection. Administration-only (cars.assign
   * holders with a linked Telegram chat).
   */
  @Cron('0 0 17 * * *')
  async shiftHandoverDigest() {
    try {
      const now = new Date();
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

      const liveAssignments = await this.prisma.carAssignment.findMany({
        where: { releasedAt: null, driverBackAtOfficeAt: null },
        include: {
          vehicle: { select: { vehicleNo: true } },
          driver: { select: { name: true } },
          request: { select: { docNumber: true, carRequest: { select: { endDate: true } } } },
        },
      });
      const onRoad = liveAssignments.filter((a) => a.request?.carRequest);
      const delayed = onRoad.filter((a) => a.estimatedReturnAt && new Date(a.estimatedReturnAt) > new Date(a.request.carRequest!.endDate));

      const today = await this.prisma.carRequest.findMany({
        where: {
          request: { status: { in: ['APPROVED', 'IN_PROGRESS'] as never[] } },
          startDate: { gte: now, lt: dayEnd },
          vehicleId: { not: null },
        },
        orderBy: { startDate: 'asc' },
        select: {
          startDate: true,
          vehicle: { select: { vehicleNo: true } },
          driver: { select: { name: true } },
          request: { select: { docNumber: true } },
        },
      });

      const blocked = await this.prisma.vehicleUnavailability.findMany({
        where: { status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } },
        include: { vehicle: { select: { vehicleNo: true } } },
        orderBy: { endsAt: 'asc' },
      });

      if (onRoad.length === 0 && today.length === 0 && blocked.length === 0) {
        this.logger.log('shift-handover digest: nothing to report — skipped');
        return;
      }

      const lines: string[] = [`🔄 <b>Shift handover — ${escapeHtml(yangonClock(now))}</b>`];
      if (onRoad.length > 0) {
        lines.push('', `<b>🚗 On the road (${onRoad.length}):</b>`);
        for (const a of onRoad) {
          const planned = a.request.carRequest ? yangonClock(new Date(a.request.carRequest.endDate)) : '—';
          const eta = a.estimatedReturnAt ? ` · ⏰ ETA ${yangonClock(new Date(a.estimatedReturnAt))}` : '';
          lines.push(`• ${escapeHtml(a.request.docNumber)} — ${escapeHtml(a.vehicle?.vehicleNo ?? '—')} · ${escapeHtml(a.driver?.name ?? 'no driver')} · planned end ${planned}${eta}`);
        }
      }
      if (delayed.length > 0) {
        lines.push('', `<b>⏰ Delayed (${delayed.length}) — driver reported a later return:</b>`);
        for (const a of delayed) lines.push(`• ${escapeHtml(a.request.docNumber)} — ETA ${yangonClock(new Date(a.estimatedReturnAt!))} (planned ${yangonClock(new Date(a.request.carRequest!.endDate))})`);
      }
      if (today.length > 0) {
        lines.push('', `<b>📅 Still to come today (${today.length}):</b>`);
        for (const t of today.slice(0, 10)) {
          lines.push(`• ${yangonClock(new Date(t.startDate))} — ${escapeHtml(t.request.docNumber)} · ${escapeHtml(t.vehicle?.vehicleNo ?? '—')}${t.driver ? ` · ${escapeHtml(t.driver.name)}` : ''}`);
        }
        if (today.length > 10) lines.push(`• …and ${today.length - 10} more`);
      }
      if (blocked.length > 0) {
        lines.push('', `<b>🛠 Blocked vehicles (${blocked.length}):</b>`);
        for (const u of blocked) lines.push(`• ${escapeHtml(u.vehicle?.vehicleNo ?? '—')} — ${escapeHtml(u.reason || 'Unavailable')} · until ${yangonClock(new Date(u.endsAt))}`);
      }
      lines.push('', '<i>⏰ ETA သည် ကား ပြန်ရောက်မည့် ခန့်မှန်းချိန် — Back at Office နှိပ်ပါက အလိုအလျောက် ပျက်ပြယ်မည်။</i>');
      const text = lines.join('\n');
      const adminIds = await this.permissions.usersWithPermissions(['cars.assign']);
      const admins = await this.prisma.user.findMany({
        where: { id: { in: adminIds }, telegramChatId: { not: null } },
        select: { telegramChatId: true },
      });
      for (const a of admins) {
        if (a.telegramChatId) await this.telegram.sendRaw(a.telegramChatId, text).catch(() => undefined);
      }
      this.logger.log(`shift-handover digest sent to ${admins.length} admin(s): ${onRoad.length} on-road, ${delayed.length} delayed, ${today.length} upcoming, ${blocked.length} blocked`);
    } catch (e) {
      this.logger.warn(`shiftHandoverDigest failed: ${(e as Error).message}`);
    }
  }

  /**
   * Overdue running trips: the booking window ended but the driver never tapped
   * "🏁 Back at Office" — the vehicle still shows IN_USE and blocks new bookings.
   * Ping the driver hourly and raise it to Administration (idempotent: one
   * ESCALATED notification per request per 12h). Booking stays reserved until
   * the driver signals back or Administration intervenes — that is deliberate:
   * silently freeing a car that might still be on the road would double-book it.
   */
  @Cron('0 15 * * * *') // hourly at :15
  async escalateOverdueRunning() {
    try {
      const now = new Date();
      const overdue = await this.prisma.carAssignment.findMany({
        where: {
          releasedAt: null,
          driverBackAtOfficeAt: null,
          request: { carRequest: { endDate: { lt: now } } },
        },
        include: {
          driver: { select: { id: true, name: true, telegramChatId: true } },
          vehicle: { select: { vehicleNo: true, brandModel: true } },
          request: { select: { id: true, docNumber: true, requester: { select: { fullName: true } }, carRequest: { select: { endDate: true, destination: true } } } },
        },
      });

      for (const a of overdue) {
        const ended = a.request.carRequest?.endDate;
        const overMins = ended ? Math.round((now.getTime() - new Date(ended).getTime()) / 60000) : 0;
        const when = ended ? yangonShort(new Date(ended)) : 'the scheduled end';

        // 1) driver nudge on Telegram
        if (a.driver?.telegramChatId) {
          await this.telegram.sendRaw(
            a.driver.telegramChatId,
            [
              `🏁 <b>Overdue — ${escapeHtml(a.request.docNumber)}</b>`,
              `The booking window ended at ${escapeHtml(when)} (${overMins} min ago) but the trip is still open.`,
              `Vehicle ${escapeHtml(a.vehicle?.vehicleNo ?? '—')} is still reserved.`,
              ``,
              `If you are back, tap <b>"🏁 Back at Office"</b> on your assignment message — the car frees up immediately.`,
            ].join('\n'),
          ).catch(() => undefined);
        }

        // 2) Administration escalation — one per request per 12h
        const recent = await this.prisma.notification.findFirst({
          where: { type: 'ESCALATED' as never, requestId: a.requestId, createdAt: { gte: new Date(now.getTime() - 12 * 3600 * 1000) } },
          select: { id: true },
        });
        if (recent) continue;

        const adminIds = await this.permissions.usersWithPermissions(['cars.assign']);
        await this.notifications.notifyMany(adminIds, {
          type: 'ESCALATED' as never,
          title: `🏁 Trip overdue — ${a.request.docNumber}`,
          body: `${a.driver?.name ?? 'The driver'} has not tapped "Back at Office" ${overMins} min after the window ended (${when}). Vehicle ${a.vehicle?.vehicleNo ?? '—'} is still reserved${a.driver?.telegramChatId ? ' — driver was nudged on Telegram' : ' — driver has no Telegram, call them'}. Use the request page to complete the trip or release the assignment.`,
          link: `/requests/${a.requestId}`,
          requestId: a.requestId,
        });
        this.logger.log(`escalated overdue running trip ${a.request.docNumber} (+${overMins} min)`);
      }
    } catch (e) {
      this.logger.warn(`escalateOverdueRunning failed: ${(e as Error).message}`);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** HH:MM in Yangon time for the digest lines — consolidated on the shared
 *  TZ-safe formatter (src/util/yangon-time.ts). */
function fmtYgn(d: Date): string {
  return yangonClock(d);
}
