import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { PermissionsService } from '../auth/permissions.service';

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
        body: `Vehicle ${trip.vehicle?.vehicleNo ?? ''} (${trip.vehicle?.brandModel ?? ''})${trip.driver ? ` with driver ${trip.driver.name}` : ''} is arranged for your trip starting ${trip.startDate.toLocaleString()}.`,
        link: `/requests/${trip.requestId}`,
        requestId: trip.requestId,
      });
      sent++;
    }
    return sent;
  }

  // every day 07:30 — in time for the morning's trips
  @Cron('0 30 7 * * *')
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
        const when = cr?.startDate ? new Date(cr.startDate).toLocaleString() : 'the scheduled time';
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
   * Auto-release: assignments whose request window ended with no recorded
   * trip activity keep the vehicle IN_USE forever. Mark those done so the
   * fleet availability view stays truthful. Vehicles that are genuinely on
   * the road past the window (trip STARTED) are left alone.
   */
  @Cron('0 */30 * * * *')
  async releaseExpired() {
    const now = new Date();

    const stuck = await this.prisma.carAssignment.findMany({
      where: {
        releasedAt: null,
        // link via requestId — carAssignment.carRequestId is not always set
        request: { carRequest: { endDate: { lt: now } } },
        OR: [{ trip: null }, { trip: { status: 'NOT_STARTED' } }],
      },
      include: {
        vehicle: { select: { vehicleNo: true } },
        request: { select: { docNumber: true, carRequest: { select: { endDate: true } } } },
      },
    });

    for (const a of stuck) {
      await this.prisma.$transaction([
        this.prisma.carAssignment.update({ where: { id: a.id }, data: { releasedAt: now } }),
        this.prisma.vehicle.update({ where: { id: a.vehicleId }, data: { status: 'AVAILABLE' } }),
        // mirror the release on the car row and the base document (back to APPROVED,
        // awaiting a new assignment)
        this.prisma.carRequest.update({ where: { requestId: a.requestId }, data: { vehicleId: null, driverId: null, status: 'APPROVED' } }),
        this.prisma.requestDocument.update({ where: { id: a.requestId }, data: { status: 'APPROVED' } }),
      ]);
    }
    if (stuck.length > 0) {
      console.log(`[cars] auto-released ${stuck.length} expired assignment(s): ${stuck.map((a) => a.request.docNumber).join(', ')}`);
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
        const when = ended ? new Date(ended).toLocaleString() : 'the scheduled end';

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
