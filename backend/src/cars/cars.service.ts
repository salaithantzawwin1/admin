import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TripStatus, VehicleStatus, WorkflowStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.module';
import { PermissionsService } from '../auth/permissions.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.service';
import { TelegramService } from '../telegram/telegram.service';
import { TimetableService } from '../settings/timetable.service';
import { EventsService } from '../events/events.service';
import { yangonShort } from '../util/yangon-time';
import { Actor } from '../org/org.service';

@Injectable()
export class CarsService {
  constructor(
    private prisma: PrismaService,
    private permissions: PermissionsService,
    private numbering: NumberingService,
    private notifications: NotificationsService,
    private audit: AuditService,
    private telegram: TelegramService,
    private timetable: TimetableService,
    private events: EventsService,
  ) {}

  /**
   * Create a car request: creates the base RequestDocument (workflow drives approval)
   * plus the CarRequest extension row with schedule details.
   * End date is optional — defaults to 17:00 of the start date (same-day default).
   */
  async createCarRequest(data: {
    description?: string;
    vehicleTypeRequired?: string;
    passengers?: number;
    destination: string;
    purpose?: string;
    startDate: string;
    endDate?: string;
    timeSlot?: string;
    pickupLocation?: string;
    specialRequest?: string;
  }, actor: Actor) {
    const startDate = new Date(data.startDate);
    // End optional: half-day slots take the Company Time Table window
    // (AM→morningEnd, PM→eveningEnd); other slots default to same-day 17:00
    // (most requests are single-day trips)
    const endDate = data.endDate ? new Date(data.endDate) : new Date(startDate);
    if (!data.endDate) {
      const clock = (await this.slotEndClock(data.timeSlot)) ?? '17:00';
      const [h, m] = clock.split(':').map(Number);
      endDate.setHours(h, m, 0, 0);
    }
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid dates');
    }
    if (endDate <= startDate) throw new BadRequestException('endDate must be after startDate');

    // base workflow request
    const request = await this.prisma.requestDocument.create({
      data: {
        docNumber: await this.numbering.next('CAR'),
        docType: 'CAR_REQUEST',
        title: `Car to ${data.destination}`,
        description: data.description,
        requesterId: actor.userId,
        departmentId: (await this.prisma.employee.findFirst({ where: { userId: actor.userId } }))?.departmentId,
      },
    });

    const carRequest = await this.prisma.carRequest.create({
      data: {
        requestId: request.id,
        vehicleTypeRequired: data.vehicleTypeRequired as never,
        passengers: data.passengers,
        destination: data.destination,
        purpose: data.purpose,
        specialRequest: data.specialRequest,
        startDate,
        endDate,
        timeSlot: (data.timeSlot || 'FULL_DAY') as never,
        pickupLocation: data.pickupLocation,
      },
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'CAR_REQUEST_CREATED', module: 'CARS', recordId: request.id,
      newValue: { docNumber: request.docNumber, destination: data.destination, startDate, endDate },
    });

    return { ...request, carRequest };
  }

  /** Cars attached to a base request (for the request detail page). */
  async findByRequest(requestId: string, actor?: Actor) {
    const car = await this.prisma.carRequest.findUnique({
      where: { requestId },
      include: { vehicle: true, driver: true, managerAckBy: { select: { fullName: true } }, assignment: { include: { trip: true } } },
    });
    if (!car || !actor) return car;

    // SYSTEM_ADMIN is the canonical superuser marker; other access is permission-based
    const isSystemAdmin = await this.prisma.userRole.findFirst({
      where: { userId: actor.userId, role: { name: 'SYSTEM_ADMIN' } },
      select: { userId: true },
    }).then((r) => !!r);
    const granted = await this.permissions.forUser(actor.userId);
    const canAssign = granted.includes('cars.assign');
    const isOwner = (await this.prisma.requestDocument.findUnique({ where: { id: requestId }, select: { requesterId: true } }))?.requesterId === actor.userId;
    // RBAC-native: approver-level access = approvals.act permission (was hard-coded role ADMINISTRATION)
    const isApprover = await this.permissions.userHas(actor.userId, 'approvals.act');

    if (!isOwner && !isSystemAdmin && !canAssign && !isApprover) {
      throw new ForbiddenException('No access');
    }
    // shared trip: the other riders of the same car+driver (panel badge + Telegram card)
    if (car.sharedTripId) {
      const riders = await this.prisma.requestDocument.findMany({
        where: {
          docType: 'CAR_REQUEST',
          status: { in: ['APPROVED', 'IN_PROGRESS'] },
          carRequest: { sharedTripId: car.sharedTripId },
        },
        select: { id: true, docNumber: true, requester: { select: { fullName: true } } },
        orderBy: { docNumber: 'asc' },
      });
      (car as typeof car & { sharedRiders?: { requestId: string; docNumber: string; requester: string }[] }).sharedRiders = riders
        .filter((r) => r.id !== requestId)
        .map((r) => ({ requestId: r.id, docNumber: r.docNumber, requester: r.requester.fullName }));
    }
    return car;
  }

  /** Update car details while still DRAFT. */
  async updateCarRequest(requestId: string, data: {
    destination?: string; purpose?: string; startDate?: string; endDate?: string;
    passengers?: number; vehicleTypeRequired?: string; timeSlot?: string; pickupLocation?: string;
    specialRequest?: string;
  }, actor: Actor) {
    const car = await this.prisma.carRequest.findUnique({ where: { requestId }, include: { request: true } });
    if (!car) throw new NotFoundException('Car request not found');
    if (car.request.requesterId !== actor.userId) throw new ForbiddenException('Not your request');
    if (car.request.status !== 'DRAFT') throw new BadRequestException('Only DRAFT requests can be edited');

    return this.prisma.carRequest.update({
      where: { requestId },
      data: {
        destination: data.destination,
        purpose: data.purpose,
        passengers: data.passengers,
        vehicleTypeRequired: data.vehicleTypeRequired as never,
        timeSlot: data.timeSlot as never,
        pickupLocation: data.pickupLocation,
        specialRequest: data.specialRequest,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: data.endDate ? new Date(data.endDate) : undefined,
      },
    });
  }

  /**
   * Effective end of a booking window = the later of the planned end and the
   * driver-reported ETA (⏰ Delay). A driver running past the planned window
   * keeps the car occupied — the fleet card and every conflict check use this.
   */
  private effectiveEnd(plannedEnd: Date, eta?: Date | null): Date {
    return eta && eta > plannedEnd ? eta : plannedEnd;
  }

  /** Administration-configured hand-back buffer (Settings → Fleet), default 30 min.
   *  Falls back silently when the settings module is absent (unit-test mocks). */
  private async bufferMinutes(): Promise<number> {
    try {
      const b = await this.timetable.fleetBufferMinutes();
      if (Number.isFinite(b) && b >= 0 && b <= 240) return b;
    } catch {
      /* mock-prisma tests construct the service without TimetableService */
    }
    return 30;
  }

  /** Half-day End clock from Settings → Company Time Table:
   *  HALF_DAY_AM → morningEnd, HALF_DAY_PM → eveningEnd; other slots → undefined.
   *  Falls back to the car convention (12:00 / 17:00) when the settings module
   *  is absent (unit-test mocks). Shared by createCarRequest's End default and
   *  the Telegram /car flow — one source of truth for "when does AM end?". */
  async slotEndClock(timeSlot?: string): Promise<string | undefined> {
    if (timeSlot !== 'HALF_DAY_AM' && timeSlot !== 'HALF_DAY_PM') return undefined;
    const fallback = timeSlot === 'HALF_DAY_AM' ? '12:00' : '17:00';
    try {
      const tt = await this.timetable.get();
      const clock = timeSlot === 'HALF_DAY_AM' ? tt.morningEnd : tt.eveningEnd;
      return typeof clock === 'string' && /^\d{2}:\d{2}$/.test(clock) ? clock : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Fleet overview for requesters (information only — assignment decisions
   * stay with Administration): each vehicle's current status plus its booked
   * windows over the next 7 days from live (PENDING/APPROVED/IN_PROGRESS)
   * car requests. No personal data — doc number + time window only.
   */
  async requesterFleetOverview() {
    const now = new Date();
    const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Same "Back at Office" exemption as overlaps(): once the driver tapped
    // "🏁 Back at Office" the car is physically back (vehicle shows AVAILABLE) —
    // keeping its window in the Booked list contradicted the status badge and
    // made requesters think the car was still taken.
    const exempt = await this.prisma.carAssignment.findMany({
      where: { releasedAt: null, driverBackAtOfficeAt: { not: null } },
      select: { requestId: true },
    });

    const [vehicles, bookings, blocks] = await Promise.all([
      this.prisma.vehicle.findMany({
        orderBy: { vehicleNo: 'asc' },
        select: { id: true, vehicleNo: true, brandModel: true, status: true },
      }),
      this.prisma.carRequest.findMany({
        where: {
          // base document status is the single source of truth (CarRequest.status
          // is only a mirror kept in sync by the workflow status-mirror hook)
          request: { status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as WorkflowStatus[] } },
          startDate: { lt: in7days },
          endDate: { gt: now },
          ...(exempt.length ? { requestId: { notIn: exempt.map((b) => b.requestId) } } : {}),
        },
        select: {
          vehicleId: true,
          startDate: true,
          endDate: true,
          request: { select: { docNumber: true } },
          assignment: { select: { estimatedReturnAt: true } },
        },
        orderBy: { startDate: 'asc' },
      }),
      // Administration-blocked windows (service / inspection / repair) — shown
      // on the 7-day card like a booking and treated as a hard status below.
      this.prisma.vehicleUnavailability.findMany({
        where: { status: 'ACTIVE', startsAt: { lt: in7days }, endsAt: { gt: now } },
        select: { vehicleId: true, startsAt: true, endsAt: true, reason: true },
      }),
    ]);

    // The badge is the PHYSICAL status, not the booking state: a car committed
    // to a FUTURE trip is not "in use" yet — it is merely BOOKED (the windows
    // below say so). assign()/reassign() flip the DB status to IN_USE at
    // assignment time, so derive the true badge from live windows instead:
    //   • a booking whose window covers now           → IN_USE (on the road)
    //   • only future bookings                        → BOOKED (committed, not rolling)
    //   • UNDER_MAINTENANCE / OUT_OF_SERVICE          → kept verbatim (physical)
    //   • otherwise                                   → AVAILABLE
    // The stale-DB-IN_USE trust that used to sit here ('|| v.status === IN_USE'
    // → BOOKED) was removed: a released assignment whose status flip back got
    // lost anywhere between Oct 2-5 left 2P2942 flagged BOOKED with "No
    // bookings in the next 7 days" — a contradiction the requester can see.
    // The badge is now derived purely from live windows + running-late trips,
    // exactly like Fleet listVehicles() does.
    // A trip the driver STARTED that runs past its window keeps covering "now"
    // through the base-status filter only until endDate — a running-late ride
    // would flash AVAILABLE and let someone else book the car. Treat the trip
    // as still covering now until its odometer close-out (Back at Office /
    // completeTrip) — the same exemption the conflict checks apply.
    const startedTrips = await this.prisma.carAssignment.findMany({
      where: { releasedAt: null, trip: { status: 'STARTED' } },
      select: { vehicleId: true, estimatedReturnAt: true, request: { select: { carRequest: { select: { endDate: true } } } } },
    });
    // running-late map carries the EFFECTIVE end (planned end vs driver ETA —
    // whichever is later) so a delayed STARTED trip keeps covering "now" that long
    const runningLate = new Map(
      startedTrips
        .filter((t) => t.request.carRequest)
        .map((t) => [t.vehicleId, this.effectiveEnd(new Date(t.request.carRequest!.endDate), t.estimatedReturnAt)] as const),
    );
    const buf = await this.bufferMinutes();
    return vehicles.map((v) => {
      const mine = bookings.filter((b) => b.vehicleId === v.id);
      const parked = v.status === 'UNDER_MAINTENANCE' || v.status === 'OUT_OF_SERVICE';
      const lateEnd = runningLate.get(v.id);
      const coversNow = mine.some((b) => b.startDate <= now && b.endDate >= now) || (lateEnd !== undefined && lateEnd >= now);
      // Administration-blocked window (service/inspection) covering now → the car
      // is physically not drivable regardless of any booking around it.
      const blockedNow = blocks.some((u) => u.vehicleId === v.id && u.startsAt <= now && u.endsAt > now);
      // BOOKED is a presentational value (not in the Prisma enum) — type it explicitly
      const status: VehicleStatus | 'BOOKED' = blockedNow
        ? 'UNDER_MAINTENANCE'
        : parked
          ? v.status
          : coversNow
            ? 'IN_USE'
            : mine.length > 0 || lateEnd !== undefined
              ? 'BOOKED'
              : 'AVAILABLE';
      return {
        ...v,
        status,
        bookings: [
          // effective end (planned end vs driver-reported ETA) + the hand-back
          // buffer produce the "likely free from ~HH:mm" hint requesters see
          ...mine.map((b) => ({
            docNumber: b.request?.docNumber,
            startDate: b.startDate,
            endDate: b.endDate,
            estimatedReturnAt: b.assignment?.estimatedReturnAt ?? null,
            likelyFreeFrom: new Date(this.effectiveEnd(b.endDate, b.assignment?.estimatedReturnAt).getTime() + buf * 60_000),
          })),
          // blocked windows surface on the same card (reason = the booking label)
          ...blocks
            .filter((u) => u.vehicleId === v.id)
            .map((u) => ({ docNumber: `🛠 ${u.reason || 'Unavailable'}`, startDate: u.startsAt, endDate: u.endsAt })),
        ].sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()),
      };
    });
  }

  /**
   * Clash preview: active car requests whose window overlaps the given window —
   * lets the form warn the requester BEFORE submitting (no vehicle needed).
   */
  async checkWindowConflicts(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid window');
    }
    const conflicts = await this.prisma.carRequest.findMany({
      where: {
        // filter on the BASE document status, not CarRequest.status — the workflow
        // engine writes request_documents.status while CarRequest.status can stay
        // DRAFT forever (no mirroring), which hid every approved booking from this
        // pre-warning. Rejected/cancelled/returned docs must not warn.
        request: { status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as WorkflowStatus[] } },
        startDate: { lt: end },
        endDate: { gt: start },
      },
      select: {
        startDate: true,
        endDate: true,
        destination: true,
        // Back-at-Office trim + driver-ETA extension: a driver who signalled
        // "Back at Office" freed the vehicle at that moment — the alert must not
        // cover time after it; a ⏰ Delay report extends the window instead.
        assignment: { select: { driverBackAtOfficeAt: true, estimatedReturnAt: true } },
        request: { select: { docNumber: true } },
      },
      orderBy: { startDate: 'asc' },
      take: 10,
    });
    // Administration-blocked windows (service/inspection) warn too — a new
    // request landing inside them cannot be assigned until reshuffled.
    const blocked = await this.prisma.vehicleUnavailability.findMany({
      where: { status: 'ACTIVE', startsAt: { lt: end }, endsAt: { gt: start } },
      select: { startsAt: true, endsAt: true, reason: true, vehicle: { select: { vehicleNo: true } } },
      orderBy: { startsAt: 'asc' },
      take: 10,
    });
    // SQL already checked the PLANNED windows overlap; trim each clash to the
    // actual absence (early Back at Office) and drop clashes that no longer
    // reach the new window at all — same "Back at Office" exemption the
    // availability/assign paths already apply, now also for the pre-warning.
    const trimmed = conflicts
      .map((c) => {
        const planned = c.endDate;
        const back = c.assignment?.driverBackAtOfficeAt;
        // no Back at Office yet → the driver's ⏰ ETA (when later) holds the car
        const late = !back ? this.effectiveEnd(planned, c.assignment?.estimatedReturnAt) : planned;
        // effective end = the earlier of the ETA-extended end and the driver's return
        return {
          ...c,
          ...(back && back < late ? { endDate: back } : late > planned ? { endDate: late } : {}),
        };
      })
      .filter((c) => c.endDate > start)
      .map(({ assignment: _assignment, ...rest }) => rest);
    // blocked windows are surfaced as their own list so the form can name the
    // car + reason ("🛠 Service") instead of pretending it is a booking
    const blockedWindows = blocked.map((u) => ({
      startDate: u.startsAt,
      endDate: u.endsAt,
      vehicleNo: u.vehicle?.vehicleNo ?? '—',
      reason: u.reason || 'Unavailable',
    }));
    // the form's "likely free from ~" hint uses the same buffer as the fleet card
    return { conflicts: trimmed, blockedWindows, bufferMinutes: await this.bufferMinutes() };
  }

  /**
   * Availability check for a vehicle in a time window.
   * Overlap rule: existing.start < new.end AND existing.end > new.start
   * considering requests in PENDING_APPROVAL/APPROVED/IN_PROGRESS with an assignment
   * (assigned vehicles) or (before assignment) overlapping approved car requests.
   */
  async checkAvailability(vehicleId: string, startDate: string, endDate: string, excludeRequestId?: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    return this.overlaps(vehicleId, start, end, excludeRequestId);
  }

  private async overlaps(vehicleId: string, start: Date, end: Date, excludeRequestId?: string) {
    // vehicle is free again once the driver signalled "Back at Office" — those
    // requests must not block a new overlapping trip (CarAssignment.carRequestId
    // is never set by assign(), so the CarRequest.assignment relation can't be used)
    const exempt = await this.prisma.carAssignment.findMany({
      where: { vehicleId, releasedAt: null, driverBackAtOfficeAt: { not: null } },
      select: { requestId: true },
    });
    // Administration-blocked window (service/inspection/repair) overlapping the
    // requested window → the vehicle is NOT available for it. No exemption — a
    // blocked car is blocked for everyone (the admin must cancel the window).
    const block = await this.prisma.vehicleUnavailability.findFirst({
      where: { vehicleId, status: 'ACTIVE', startsAt: { lt: end }, endsAt: { gt: start } },
      select: { startsAt: true, endsAt: true, reason: true },
    });
    if (block) {
      return {
        available: false,
        conflicts: [
          {
            requestId: 'BLOCKED',
            sharedTripId: null,
            startDate: block.startsAt,
            endDate: block.endsAt,
            request: { docNumber: `🛠 ${block.reason || 'Vehicle unavailable'} — cancel the unavailability window first` },
          },
        ],
      };
    }
    const conflicts = await this.prisma.carRequest.findMany({
      where: {
        vehicleId,
        // exclude THIS request's own booking (requestId, not the CarRequest.id —
        // the old `id: { not: requestId }` never matched, so admin-shift kept
        // colliding with the very booking it was shifting)
        requestId: {
          ...(excludeRequestId ? { not: excludeRequestId } : {}),
          ...(exempt.length ? { notIn: exempt.map((b) => b.requestId) } : {}),
        },
        // base document status (SUBMITTED included — a submitted booking already
        // plans the car) — CarRequest.status is only a mirror
        request: { status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as WorkflowStatus[] } },
        startDate: { lt: end },
        // a ⏰ Delay report stretches a booking past its planned end, so the SQL net
        // is widened: planned end OR the driver-reported ETA may still reach `start`
        OR: [{ endDate: { gt: start } }, { assignment: { estimatedReturnAt: { gt: start } } }],
      },
      select: { requestId: true, sharedTripId: true, startDate: true, endDate: true, request: { select: { docNumber: true } }, assignment: { select: { estimatedReturnAt: true } } },
    });
    // effective end (planned end vs ETA — whichever is later) decides the clash
    const stretched = conflicts
      .filter((c) => this.effectiveEnd(c.endDate, c.assignment?.estimatedReturnAt) > start)
      .map(({ assignment: _assignment, ...rest }) => rest);
    // a shared-trip member only blocks rides OUTSIDE its own group — when the
    // caller belongs to a group, same-group bookings are not conflicts
    if (excludeRequestId) {
      const own = await this.prisma.carRequest.findUnique({ where: { requestId: excludeRequestId }, select: { sharedTripId: true } });
      if (own?.sharedTripId) {
        const inGroup = stretched.filter((c) => c.sharedTripId === own.sharedTripId);
        if (inGroup.length > 0) {
          const remaining = stretched.filter((c) => c.sharedTripId !== own.sharedTripId);
          return { available: remaining.length === 0, conflicts: remaining };
        }
      }
    }
    return { available: stretched.length === 0, conflicts: stretched };
  }

  /** Administration assigns vehicle (+ optional driver) to an APPROVED car request.
   *  `share=true` explicitly joins an overlapping request onto the same car+driver
   *  (convoy mode) — the overlap/driver-busy guards deliberately step aside, but
   *  maintenance/out-of-service vehicles and planned-absent drivers still block. */
  async assign(requestId: string, data: { vehicleId: string; driverId?: string; share?: boolean }, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { carRequest: { include: { assignment: true } } },
    });
    if (!request || !request.carRequest) throw new NotFoundException('Car request not found');
    const carReq = request.carRequest;
    if (request.status !== 'APPROVED') {
      throw new BadRequestException(`Only APPROVED requests can be assigned (current: ${request.status})`);
    }
    // An existing assignment only blocks re-assignment while it is still active —
    // a released assignment (releasedAt set) may be re-assigned, so its row is updated.
    if (request.carRequest.assignment && request.carRequest.assignment.releasedAt === null) {
      throw new ConflictException('Vehicle already assigned to this request');
    }

    const share = data.share === true; // explicit opt-in from the Car panel
    if (share && !data.driverId) {
      throw new BadRequestException('Shared trips need a driver — pick the driver of the trip you are joining');
    }

    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: data.vehicleId } });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.status === 'OUT_OF_SERVICE' || vehicle.status === 'UNDER_MAINTENANCE') {
      throw new ConflictException(`Vehicle ${vehicle.vehicleNo} is ${vehicle.status}`);
    }

    // planned-unavailability guard: a vehicle blocked by Administration (service /
    // inspection / repair) for the trip window cannot be assigned — no exemption
    // (even shared trips must take another car; cancel the window first instead)
    const blocked = await this.prisma.vehicleUnavailability.findFirst({
      where: { vehicleId: data.vehicleId, status: 'ACTIVE', startsAt: { lt: request.carRequest.endDate }, endsAt: { gt: request.carRequest.startDate } },
      select: { startsAt: true, endsAt: true, reason: true },
    });
    if (blocked) {
      throw new ConflictException(
        `Vehicle ${vehicle.vehicleNo} is unavailable ${blocked.startsAt.toISOString()} → ${blocked.endsAt.toISOString()}${blocked.reason ? ` (${blocked.reason})` : ''} — overlaps this trip`,
      );
    }

    // planned-absence guard: a driver with ACTIVE absence covering the trip window cannot be assigned
    // (shared trips included — a driver cannot convoy two trips while officially on leave)
    const start = request.carRequest.startDate;
    const end = request.carRequest.endDate;
    if (data.driverId) {
      const absent = await this.prisma.driverAbsence.findFirst({
        where: {
          driverId: data.driverId,
          status: 'ACTIVE',
          startsAt: { lt: end },
          endsAt: { gt: start },
        },
        select: { startsAt: true, endsAt: true, reason: true },
      });
      if (absent) {
        throw new ConflictException(
          `Driver is on planned absence ${absent.startsAt.toISOString().slice(0, 10)} → ${absent.endsAt.toISOString().slice(0, 10)}${absent.reason ? ` (${absent.reason})` : ''} — overlaps this trip`,
        );
      }
    }

    // double-booking prevention: transaction + overlap re-check
    // (skipped for explicit shared trips — see the group stamp inside the tx)
    const assignment = await this.prisma.$transaction(async (tx) => {
      // shared-trip group: join the overlapping booking already riding this car+driver
      // (looked up INSIDE the tx; the stamped group makes overlaps() skip the pair)
      let sharedTripId: string | null = null;
      if (share) {
        // join the overlapping booking already riding this car+driver. Matching on
        // vehicleId only (not driverId — the first ride may have been assigned
        // driver-less) and stamping the FIRST member too so both rows share the
        // group id that overlaps() uses to skip the pair.
        const group = await tx.carRequest.findFirst({
          where: {
            vehicleId: data.vehicleId,
            requestId: { not: requestId },
            request: { status: 'IN_PROGRESS' },
            startDate: { lt: end },
            endDate: { gt: start },
          },
          orderBy: { startDate: 'asc' },
          select: { requestId: true, sharedTripId: true },
        });
        sharedTripId = group?.sharedTripId ?? crypto.randomUUID();
        if (group && !group.sharedTripId) {
          // first member of a new group gets its stamp here (B carries the same id below)
          await tx.carRequest.update({ where: { requestId: group.requestId }, data: { sharedTripId } });
        }
      }
      // re-check overlap inside the transaction for race safety
      // same "Back at Office" exemption as checkAvailability — inside the tx for race safety
      const exempt = await tx.carAssignment.findMany({
        where: { vehicleId: data.vehicleId, releasedAt: null, driverBackAtOfficeAt: { not: null } },
        select: { requestId: true },
      });
      const conflicts = await tx.carRequest.findMany({
        where: {
          vehicleId: data.vehicleId,
          requestId: { not: requestId, ...(exempt.length ? { notIn: exempt.map((b) => b.requestId) } : {}) },
          // base document status (single source of truth) — CarRequest.status is a mirror
          request: { status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as WorkflowStatus[] } },
          startDate: { lt: end },
          endDate: { gt: start },
        },
      });
      // shared trips skip the overlap block — the admin explicitly linked the rides
      if (conflicts.length > 0 && !share) {
        throw new ConflictException(
          `Vehicle ${vehicle.vehicleNo} is already booked ${conflicts[0].startDate.toISOString()} → ${conflicts[0].endDate.toISOString()}`,
        );
      }

      // upsert: after a release the assignment row still exists (releasedAt set),
      // so re-assigning must update it rather than create a duplicate
      const a = await tx.carAssignment.upsert({
        where: { requestId },
        create: {
          requestId,
          carRequestId: carReq.id,
          vehicleId: data.vehicleId,
          driverId: data.driverId,
          assignedById: actor.userId,
        },
        update: {
          // keep the backlink to the car request — sendAssignment() needs it to
          // build the driver's route message (silently skipped when missing!)
          carRequestId: carReq.id,
          vehicleId: data.vehicleId,
          driverId: data.driverId,
          assignedById: actor.userId,
          assignedAt: new Date(),
          releasedAt: null,
          // a re-used assignment row starts a fresh ack cycle (previous trip's
          // Noted/Arrived/Back timestamps and Telegram message must not leak)
          driverNotedAt: null,
          driverArrivedAt: null,
          driverBackAtOfficeAt: null,
          telegramMessageId: null,
        },
      });
      await tx.carRequest.update({
        where: { requestId },
        // sharedTripId is stamped (or cleared on a plain re-assign) right beside
        // the vehicle links so availability queries can exclude the group
        data: { vehicleId: data.vehicleId, driverId: data.driverId, sharedTripId, status: 'IN_PROGRESS' },
      });
      // keep the base document in step with the car-specific status (list badges,
      // dashboards and 'my requests' views read request_documents)
      await tx.requestDocument.update({ where: { id: requestId }, data: { status: 'IN_PROGRESS' } });
      await tx.vehicle.update({
        where: { id: data.vehicleId },
        data: { status: 'IN_USE' },
      });
      if (data.driverId) {
        await tx.driver.update({ where: { id: data.driverId }, data: { status: 'ON_TRIP' } }).catch(() => undefined);
      }
      return a;
    });

    // the requester's bell/Telegram copy names the driver when one is assigned
    // (same wording as the driver's "Car is ready" message); no driver yet →
    // vehicle line only
    const driver = data.driverId
      ? await this.prisma.driver.findUnique({ where: { id: data.driverId }, select: { name: true } })
      : null;
    await this.notifications.notify({
      userId: request.requesterId,
      type: 'CAR_ASSIGNED',
      title: `Vehicle assigned to ${request.docNumber}`,
      // shared-trip riders are told up front: one car, other riders, same window
      body: `${vehicle.vehicleNo} (${vehicle.brandModel}) has been assigned for your trip${driver?.name ? ` — Driver ${driver.name}` : ''}.${share ? ' Note: this is a SHARED trip — you ride the same car as another request in this window.' : ''}`,
      link: `/requests/${requestId}`, requestId,
    });

    // Telegram route message to the driver (silent no-op when token unset/disabled;
    // fire-and-forget so a slow/unreachable Telegram never delays the assignment).
    // For a shared trip, ALSO repaint the peer assignment's card — its driver card
    // was rendered before this request joined the group and must show the new
    // 🧑‍🤝‍🧑 Shared trip section (and the peer requester's panel refetches via SSE).
    this.telegram.sendAssignment(assignment.id).catch(() => undefined);
    if (share) {
      // sharedTripId was stamped on the CAR REQUEST inside the tx (assignment rows
      // carry no such column) — read it there, then repaint the whole group via the
      // TelegramService helper (covers this card AND the peer's).
      await this.prisma.carRequest.findUnique({ where: { requestId }, select: { sharedTripId: true } })
        .then((row) => (row?.sharedTripId ? this.telegram.repaintDriverCards(assignment.id) : undefined))
        .catch(() => undefined);
    }    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'CAR_ASSIGNED', module: 'CARS', recordId: requestId,
      newValue: { vehicleId: data.vehicleId, driverId: data.driverId, ...(share ? { sharedTrip: true } : {}) },
    });
    return assignment;
  }

  /** Combined "Back at Office — BOTH trips" for a shared pair (Administration override; mirrors manualAck). */
  async combinedBack(requestId: string, actor: Actor) {
    const a = await this.prisma.carAssignment.findUnique({ where: { requestId } });
    if (!a) throw new NotFoundException('Assignment not found');
    const results = await this.telegram.combinedBackAtOffice(a.id, { userId: actor.userId, username: actor.username });
    const done = results.filter((r) => r.done).length;
    return { done, results, freedVehicleId: a.vehicleId };
  }

  /**
   * Department managers allowed to ack a car request: every DEPARTMENT_HEAD
   * (or users.manage holder) of ANY department the requester's employee belongs
   * to — one employee can head several departments. SYSTEM_ADMIN always passes.
   */
  async managerAckUserIds(requestId: string): Promise<string[]> {
    const doc = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      select: { requester: { select: { employee: { select: { departmentId: true, headedDepartments: { select: { id: true } } } } } } },
    });
    const employee = doc?.requester?.employee;
    if (!employee) return [];
    // departments the requester belongs to + departments they head (either counts)
    const deptIds = [...new Set([employee.departmentId, ...employee.headedDepartments.map((d) => d.id)].filter(Boolean) as string[])];
    if (deptIds.length === 0) return [];
    const heads = await this.prisma.userRole.findMany({
      where: {
        role: { name: 'DEPARTMENT_HEAD' },
        user: { status: 'ACTIVE', employee: { OR: [{ departmentId: { in: deptIds } }, { headedDepartments: { some: { id: { in: deptIds } } } }] } },
      },
      select: { userId: true },
    });
    return [...new Set(heads.map((h) => h.userId))];
  }

  /**
   * OPTIONAL manager acknowledgement of a car request — pure FYI for the
   * department manager, never blocks the workflow or the assignment.
   */
  async managerAck(requestId: string, actor: Actor) {
    const allowed = await this.managerAckUserIds(requestId);
    const isSuper = await this.prisma.userRole.findFirst({ where: { userId: actor.userId, role: { name: 'SYSTEM_ADMIN' } } });
    if (!isSuper && !allowed.includes(actor.userId)) {
      throw new ForbiddenException('Only a department manager of the requester can acknowledge');
    }
    const car = await this.prisma.carRequest.findUnique({ where: { requestId } });
    if (!car) throw new NotFoundException('Car request not found');
    if (car.managerAckAt) throw new ConflictException('Already acknowledged');
    const updated = await this.prisma.carRequest.update({
      where: { requestId },
      data: { managerAckAt: new Date(), managerAckById: actor.userId },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'CAR_MANAGER_ACK', module: 'CARS', recordId: requestId,
    });
    return updated;
  }

  /** Pending manager acks — the requester's department(s) I manage (bell inbox helper). */
  async myPendingManagerAcks(userId: string) {
    const employee = await this.prisma.employee.findFirst({ where: { userId }, select: { departmentId: true, headedDepartments: { select: { id: true } } } });
    if (!employee) return [];
    const deptIds = [...new Set([employee.departmentId, ...employee.headedDepartments.map((d) => d.id)].filter(Boolean) as string[])];
    if (deptIds.length === 0) return [];
    return this.prisma.requestDocument.findMany({
      where: {
        docType: 'CAR_REQUEST',
        status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as WorkflowStatus[] },
        carRequest: { managerAckAt: null },
        OR: [
          { requester: { employee: { departmentId: { in: deptIds } } } },
          { requester: { employee: { headedDepartments: { some: { id: { in: deptIds } } } } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, docNumber: true, title: true, status: true, createdAt: true,
        requester: { select: { fullName: true } },
        department: { select: { name: true } },
        carRequest: { select: { destination: true, startDate: true, endDate: true, managerAckAt: true } },
      },
    });
  }

  /** Release assignment (e.g. trip cancelled). */
  /**
   * Change the assigned vehicle/driver of a live assignment (fleet plan change).
   * Atomic: releases the previous assignment row state and re-writes it to the new
   * vehicle/driver (fresh ack cycle). The PREVIOUS driver gets a Telegram cancel
   * notice (their job is off), the NEW driver gets the full route message, and the
   * requester is told who is coming instead. A started trip blocks the change.
   */
  async reassign(requestId: string, data: { vehicleId: string; driverId?: string }, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: {
        carRequest: { include: { assignment: { include: { trip: true, driver: true, vehicle: true } }, vehicle: true } },
      },
    });
    if (!request || !request.carRequest) throw new NotFoundException('Car request not found');
    const carReq = request.carRequest;
    const assignment = carReq.assignment;
    if (!assignment || assignment.releasedAt !== null) throw new NotFoundException('No active assignment to change — assign instead');
    if (request.status !== 'IN_PROGRESS') {
      throw new BadRequestException(`Only IN_PROGRESS assignments can be changed (current: ${request.status})`);
    }
    if (assignment.trip && assignment.trip.status === 'STARTED') {
      throw new BadRequestException('Trip already started — complete or cancel the trip first');
    }
    if (data.vehicleId === assignment.vehicleId && (data.driverId ?? null) === (assignment.driverId ?? null)) {
      throw new ConflictException('Pick a different vehicle or driver');
    }

    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: data.vehicleId } });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.status === 'OUT_OF_SERVICE' || vehicle.status === 'UNDER_MAINTENANCE') {
      throw new ConflictException(`Vehicle ${vehicle.vehicleNo} is ${vehicle.status}`);
    }
    // planned-unavailability guard for the replacement vehicle (same rule as assign)
    const blockedRe = await this.prisma.vehicleUnavailability.findFirst({
      where: { vehicleId: data.vehicleId, status: 'ACTIVE', startsAt: { lt: request.carRequest.endDate }, endsAt: { gt: request.carRequest.startDate } },
      select: { startsAt: true, endsAt: true, reason: true },
    });
    if (blockedRe) {
      throw new ConflictException(
        `Vehicle ${vehicle.vehicleNo} is unavailable ${blockedRe.startsAt.toISOString()} → ${blockedRe.endsAt.toISOString()}${blockedRe.reason ? ` (${blockedRe.reason})` : ''} — overlaps this trip`,
      );
    }
    // planned-absence guard for the replacement driver (same rule as assign)
    if (data.driverId && data.driverId !== assignment.driverId) {
      const start = request.carRequest.startDate;
      const end = request.carRequest.endDate;
      const absent = await this.prisma.driverAbsence.findFirst({
        where: {
          driverId: data.driverId,
          status: 'ACTIVE',
          startsAt: { lt: end },
          endsAt: { gt: start },
        },
        select: { startsAt: true, endsAt: true, reason: true },
      });
      if (absent) {
        throw new ConflictException(
          `Driver is on planned absence ${absent.startsAt.toISOString().slice(0, 10)} → ${absent.endsAt.toISOString().slice(0, 10)}${absent.reason ? ` (${absent.reason})` : ''} — overlaps this trip`,
        );
      }
    }
    const previousDriverId = assignment.driverId;

    await this.prisma.$transaction(async (tx) => {
      // overlap re-check for the NEW vehicle (excluding this request's own booking).
      // Same "Back at Office" exemption as assign()/overlaps(): a vehicle whose
      // driver already signalled "Back at Office" is free again and must not
      // block the new booking (CarAssignment.carRequestId is not reliably set,
      // so the CarRequest.assignment relation can't be joined here).
      const activeStates: WorkflowStatus[] = ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'];
      const exempt = await tx.carAssignment.findMany({
        where: { vehicleId: data.vehicleId, releasedAt: null, driverBackAtOfficeAt: { not: null } },
        select: { requestId: true },
      });
      const conflicts = await tx.carRequest.findMany({
        where: {
          vehicleId: data.vehicleId,
          requestId: { not: requestId, ...(exempt.length ? { notIn: exempt.map((b) => b.requestId) } : {}) },
          // base document status (single source of truth) — CarRequest.status is a mirror
          request: { status: { in: activeStates } },
          startDate: { lt: carReq.endDate },
          endDate: { gt: carReq.startDate },
        },
        select: { requestId: true },
      });
      if (conflicts.length > 0) {
        throw new ConflictException(`Vehicle ${vehicle.vehicleNo} is already booked in this window — pick another`);
      }

      // free the OLD vehicle (only when no other live booking uses it)
      if (carReq.vehicleId && carReq.vehicleId !== data.vehicleId) {
        const others = await tx.carRequest.count({
          where: { vehicleId: carReq.vehicleId, requestId: { not: requestId }, request: { status: { in: activeStates } } },
        });
        if (others === 0) await tx.vehicle.update({ where: { id: carReq.vehicleId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
      }
      // free the OLD driver (only when no other live booking uses them)
      if (previousDriverId && previousDriverId !== (data.driverId ?? null)) {
        const otherTrips = await tx.carRequest.count({
          where: { driverId: previousDriverId, requestId: { not: requestId }, request: { status: { in: activeStates } } },
        });
        if (otherTrips === 0) await tx.driver.update({ where: { id: previousDriverId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
      }

      // rewrite the same assignment row to the new vehicle/driver — fresh ack cycle
      await tx.carAssignment.update({
        where: { id: assignment.id },
        data: {
          carRequestId: carReq.id,
          vehicleId: data.vehicleId,
          driverId: data.driverId ?? null,
          assignedById: actor.userId,
          assignedAt: new Date(),
          driverNotedAt: null,
          driverArrivedAt: null,
          driverBackAtOfficeAt: null,
          telegramMessageId: null,
        },
      });
      await tx.carRequest.update({
        where: { requestId },
        // moving off the shared car+driver clears the group stamp — this ride
        // becomes a normal single booking again (re-assign as share to re-link)
        data: { vehicleId: data.vehicleId, driverId: data.driverId ?? null, sharedTripId: null },
      });
      await tx.vehicle.update({ where: { id: data.vehicleId }, data: { status: 'IN_USE' } });
      if (data.driverId) {
        await tx.driver.update({ where: { id: data.driverId }, data: { status: 'ON_TRIP' } }).catch(() => undefined);
      }
    });

    // notify: previous driver (Telegram direct — job is off), new driver (route message), requester
    if (previousDriverId && previousDriverId !== (data.driverId ?? null)) {
      await this.telegram.notifyDriverOfReassign(requestId, request.docNumber, previousDriverId, `${vehicle.vehicleNo} (${vehicle.brandModel})`).catch(() => undefined);
    }
    await this.telegram.sendAssignment(assignment.id).catch(() => undefined);
    const prevVehicleLabel = `${carReq.vehicle?.vehicleNo ?? ''}${carReq.vehicle?.brandModel ? ` (${carReq.vehicle.brandModel})` : ''}`.trim() || 'previous vehicle';
    const vehicleChanged = data.vehicleId !== assignment.vehicleId;
    const driverChanged = (data.driverId ?? null) !== (assignment.driverId ?? null);
    // name the new driver in the requester's notification; the same row also
    // feeds the AMS-account bell mirror below (one lookup instead of two)
    const newDriver = (driverChanged && data.driverId)
      ? await this.prisma.driver.findUnique({ where: { id: data.driverId }, select: { name: true, employee: { select: { user: { select: { id: true } } } } } })
      : null;
    await this.notifications.notify({
      userId: request.requesterId,
      type: 'CAR_ASSIGNED',
      title: `Assignment changed for ${request.docNumber}`,
      body: [
        vehicleChanged ? `Vehicle: ${prevVehicleLabel} → ${vehicle.vehicleNo} (${vehicle.brandModel})` : null,
        driverChanged ? (newDriver?.name ? `Driver: ${newDriver.name}.` : 'Driver has been updated.') : null,
        `Schedule: ${yangonShort(carReq.startDate)} → ${yangonShort(carReq.endDate)} (unchanged unless you were told otherwise).`,
      ].filter(Boolean).join(' · '),
      link: `/requests/${requestId}`, requestId,
    });
    // NEW driver holds an AMS account in some setups — mirror a bell notification too
    if (driverChanged && data.driverId) {
      const newDriverUserId = newDriver?.employee?.user?.id;
      if (newDriverUserId) {
        await this.notifications.notify({
          userId: newDriverUserId,
          type: 'CAR_ASSIGNED',
          title: `You are the driver for ${request.docNumber}`,
          body: `${vehicle.vehicleNo} (${vehicle.brandModel}) · ${yangonShort(carReq.startDate)} → ${yangonShort(carReq.endDate)} · pickup ${carReq.pickupLocation ?? '—'} → ${carReq.destination}.${carReq.specialRequest ? ` ⭐ Special: ${carReq.specialRequest}` : ''}`,
          link: `/requests/${requestId}`, requestId,
        });
      }
    }

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'CAR_REASSIGNED', module: 'CARS', recordId: requestId,
      oldValue: { vehicleId: assignment.vehicleId, driverId: assignment.driverId },
      newValue: { vehicleId: data.vehicleId, driverId: data.driverId ?? null },
    });

    return this.prisma.carAssignment.findUnique({ where: { requestId }, include: { vehicle: true, driver: true } });
  }

  async release(requestId: string, actor: Actor) {
    const assignment = await this.prisma.carAssignment.findUnique({
      where: { requestId },
      include: { trip: true },
    });
    if (!assignment) throw new NotFoundException('No assignment for this request');
    if (assignment.trip && assignment.trip.status === 'STARTED') {
      throw new BadRequestException('Trip already started — complete or cancel the trip first');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.carAssignment.update({ where: { id: assignment.id }, data: { releasedAt: new Date(), estimatedReturnAt: null } });
      await tx.carRequest.update({ where: { requestId }, data: { vehicleId: null, driverId: null, sharedTripId: null, status: 'APPROVED' } });
      await tx.requestDocument.update({ where: { id: requestId }, data: { status: 'APPROVED' } });
      await tx.vehicle.update({ where: { id: assignment.vehicleId }, data: { status: 'AVAILABLE' } });
      if (assignment.driverId) {
        await tx.driver.update({ where: { id: assignment.driverId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
      }
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'CAR_ASSIGNMENT_RELEASED', module: 'CARS', recordId: requestId,
    });
    return { success: true };
  }

  /**
   * Administration actions on APPROVED requests: cancel outright or shift the
   * time window (fleet plan changes). The requester is notified either way.
   */
  async adminCancelApproved(requestId: string, comment: string | undefined, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { carRequest: { include: { assignment: { include: { trip: true } } } } },
    });
    if (!request || request.docType !== 'CAR_REQUEST') throw new NotFoundException('Car request not found');
    if (!['APPROVED', 'PENDING_APPROVAL', 'IN_PROGRESS'].includes(request.status)) {
      throw new BadRequestException(`Cannot cancel from status ${request.status}`);
    }
    if (request.status === 'IN_PROGRESS' && request.carRequest?.assignment?.trip?.status === 'STARTED') {
      throw new BadRequestException('Trip already started — complete the trip first');
    }

    await this.prisma.$transaction(async (tx) => {
      // free the vehicle/driver — but only when no OTHER live booking still uses them
      const activeStates: WorkflowStatus[] = ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'];
      if (request.carRequest?.vehicleId) {
        const others = await tx.carRequest.count({
          where: { vehicleId: request.carRequest.vehicleId, requestId: { not: requestId }, request: { status: { in: activeStates } } },
        });
        if (others === 0) {
          await tx.vehicle.update({ where: { id: request.carRequest.vehicleId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
        }
      }
      // the driver is freed by DRIVER demand, not vehicle demand — nesting this
      // inside the vehicle branch left drivers ON_TRIP forever when the vehicle
      // still had other bookings (Lay Win / Naing Naing Tun stuck since 25/28 Sep)
      if (request.carRequest?.driverId) {
        const otherTrips = await tx.carRequest.count({
          where: { driverId: request.carRequest.driverId, requestId: { not: requestId }, request: { status: { in: activeStates } } },
        });
        if (otherTrips === 0) {
          await tx.driver.update({ where: { id: request.carRequest.driverId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
        }
      }
      // release the assignment row (if any) so its booking window no longer blocks others
      if (request.carRequest?.assignment && request.carRequest.assignment.releasedAt === null) {
        await tx.carAssignment.update({ where: { id: request.carRequest.assignment.id }, data: { releasedAt: new Date(), estimatedReturnAt: null } });
      }
      // clear vehicle links + mirror the new status on the CarRequest row so
      // availability checks / fleet overview immediately stop counting this booking
      await tx.carRequest.update({
        where: { requestId },
        data: { vehicleId: null, driverId: null, sharedTripId: null, status: 'CANCELLED' },
      });
      await tx.requestDocument.update({ where: { id: requestId }, data: { status: 'CANCELLED' } });
      // (mirrored in the same transaction above)
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'CAR_ADMIN_CANCELLED', module: 'CARS', recordId: requestId,
      newValue: { comment },
    });
    await this.notifications.notify({
      userId: request.requesterId, type: 'CANCELLED',
      title: `Request ${request.docNumber} cancelled by Administration`,
      body: comment || 'Your car request was cancelled by the Administration Department.',
      link: `/requests/${requestId}`, requestId,
    });
    // the assigned driver doesn't hold an AMS account — reply to their Telegram directly
    await this.telegram.notifyDriverOfCancellation(requestId, request.docNumber, comment);
    return { success: true };
  }

  async adminShiftTime(requestId: string, data: { startDate: string; endDate?: string; comment?: string }, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      include: { carRequest: true },
    });
    if (!request || request.docType !== 'CAR_REQUEST') throw new NotFoundException('Car request not found');
    // IN_PROGRESS is allowed to match the CarPanel UI ("Shift time" shows for live
    // requests) — but a trip the driver already started must not be teleported
    // to another time window by a plan change.
    if (!['APPROVED', 'PENDING_APPROVAL', 'IN_PROGRESS'].includes(request.status)) {
      throw new BadRequestException(`Cannot shift time from status ${request.status}`);
    }
    if (request.status === 'IN_PROGRESS') {
      const assignment = await this.prisma.carAssignment.findUnique({
        where: { requestId },
        select: { trip: { select: { status: true } } },
      });
      if (assignment?.trip?.status === 'STARTED') {
        throw new BadRequestException('Trip already started — complete or release the trip before shifting the time');
      }
    }

    const start = new Date(data.startDate);
    // End OPTIONAL for admin shifts — when omitted, the ORIGINAL duration rides
    // along (move the fetch to 3:00 PM on a 4:33→5:00 request → 3:00→3:27).
    // This is the common case: Administration adjusts WHEN the car comes, not
    // how long the rider needs it.
    const originalDurationMin = request.carRequest
      ? (new Date(request.carRequest.endDate).getTime() - new Date(request.carRequest.startDate).getTime()) / 60000
      : 0;
    const end = data.endDate ? new Date(data.endDate) : new Date(start.getTime() + originalDurationMin * 60000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid time window');
    }

    // if a vehicle is already assigned, the new window must stay conflict-free
    if (request.carRequest?.vehicleId) {
      const avail = await this.overlaps(request.carRequest.vehicleId, start, end, requestId);
      if (!avail.available) {
        throw new ConflictException('The vehicle is already booked in the new window — release it or pick another window');
      }
    }

    await this.prisma.carRequest.update({
      where: { requestId },
      data: { startDate: start, endDate: end },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'CAR_TIME_SHIFTED', module: 'CARS', recordId: requestId,
      oldValue: { start: request.carRequest?.startDate, end: request.carRequest?.endDate },
      newValue: { start, end },
    });
    await this.notifications.notify({
      userId: request.requesterId, type: 'RETURNED' as never,
      title: `Request ${request.docNumber} time changed by Administration`,
      body: `New schedule: ${yangonShort(start)} → ${yangonShort(end)}.${data.comment ? ` Note: ${data.comment}` : ''}`,
      link: `/requests/${requestId}`, requestId,
    });
    // the assigned driver holds no AMS account — tell them on Telegram directly
    if (request.carRequest?.driverId) {
      await this.telegram.notifyDriverOfTimeChange(requestId, request.docNumber, request.carRequest.driverId, start, end, data.comment).catch(() => undefined);
    }
    return { success: true };
  }

  /**
   * Driver-reported ETA (Telegram ⏰ Delay quick options / custom time).
   * Stores the expected return on the ASSIGNMENT (not the request): the booking
   * window stays the plan, the ETA is the operational truth layered on top.
   * effective end = max(planned end, ETA) feeds the fleet card, the conflict
   * pre-warning and every availability check until Back at Office clears it.
   */
  async setEstimatedReturn(requestId: string, data: { minutes?: number; eta?: string }, actor?: Actor) {
    const assignment = await this.prisma.carAssignment.findUnique({
      where: { requestId },
      include: {
        vehicle: { select: { vehicleNo: true, brandModel: true } },
        driver: { select: { name: true } },
        request: { select: { docNumber: true, requesterId: true, status: true } },
        carRequest: { select: { endDate: true } },
      },
    });
    if (!assignment || assignment.releasedAt !== null) throw new NotFoundException('No active assignment for this request');

    // quick options arrive as relative minutes (+30 / +60 / custom); the Telegram
    // custom option and the web panel arrive as an absolute ISO timestamp
    let eta: Date;
    if (data.eta) {
      eta = new Date(data.eta);
    } else if (Number.isFinite(data.minutes) && (data.minutes as number) > 0) {
      eta = new Date(Date.now() + (data.minutes as number) * 60_000);
    } else {
      throw new BadRequestException('Provide minutes (> 0) or an eta timestamp');
    }
    if (Number.isNaN(eta.getTime())) throw new BadRequestException('Invalid eta timestamp');
    const planned = assignment.carRequest ? new Date(assignment.carRequest.endDate) : new Date();
    const now = new Date();
    const cap = new Date(now.getTime() + 72 * 3600 * 1000);
    // ETA must land after "now" and inside sane bounds: no wiping a delay back
    // to the past (a real extension always reaches forward), capped at +72h
    if (eta <= now) throw new BadRequestException('ETA must be in the future');
    if (eta > cap) throw new BadRequestException('ETA cannot be more than 72 hours ahead');

    const updated = await this.prisma.carAssignment.update({
      where: { requestId },
      data: { estimatedReturnAt: eta },
    });
    await this.audit.log({
      ...(actor ? { userId: actor.userId, username: actor.username } : {}),
      action: 'CAR_ETA_SET',
      module: 'CARS',
      recordId: requestId,
      username: actor?.username ?? assignment.driver?.name ?? 'driver-telegram',
      oldValue: { plannedEnd: planned, previousEta: assignment.estimatedReturnAt ?? null },
      newValue: { estimatedReturnAt: eta },
    });

    // who learns about the delay: Administration (cars.assign) + the requester —
    // the dispatcher is watching the trip and the rider is waiting for the car
    const adminIds = await this.permissions.usersWithPermissions(['cars.assign']);
    const recipients = adminIds.includes(assignment.request.requesterId) ? adminIds : [...adminIds, assignment.request.requesterId];
    const when = yangonShort(eta);
    const plannedTxt = yangonShort(planned);
    const late = eta > planned;
    const veh = assignment.vehicle ? `${assignment.vehicle.brandModel} · ${assignment.vehicle.vehicleNo}` : 'vehicle';
    const title = `⏰ Delay reported — ${assignment.request.docNumber}`;
    const body = late
      ? `Driver reports the car (${veh}) will be back around ${when} — past the planned ${plannedTxt}. The car stays blocked until then (or Back at Office).`
      : `Driver reports the car (${veh}) will be back around ${when} (planned: ${plannedTxt}).`;
    await this.notifications.notifyMany(recipients, {
      type: 'CAR_ETA_SET' as never,
      title,
      body,
      link: `/requests/${assignment.requestId}`,
      requestId: assignment.requestId,
    });
    // mirror into the linked Telegram chats (Administration + requester)
    for (const userId of recipients) {
      await this.telegram.mirrorToUser(userId, title, body, `/requests/${assignment.requestId}`).catch(() => undefined);
    }
    // the driver's own trip card shows the ETA line (editStageMessage repaints it)
    await this.telegram.sendAssignment(assignment.id, true).catch(() => undefined);
    try {
      this.events.publish('assignment.updated', { requestId: assignment.requestId });
    } catch {
      /* SSE push is best-effort */
    }
    return { success: true, estimatedReturnAt: updated.estimatedReturnAt };
  }

  /**
   * Shift-handover summary for Administration: everything the next shift needs
   * to pick up cleanly — trips on the road (with ⏰ delays flagged), today's
   * remaining trips, and vehicles currently blocked for service/inspection.
   * Local day = container TZ (Asia/Rangoon in deployment).
   */
  async handover() {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

    const liveAssignments = await this.prisma.carAssignment.findMany({
      where: { releasedAt: null, driverBackAtOfficeAt: null },
      include: {
        vehicle: { select: { vehicleNo: true, brandModel: true } },
        driver: { select: { name: true } },
        trip: { select: { status: true } },
        request: { select: { id: true, docNumber: true, carRequest: { select: { endDate: true, destination: true } } } },
      },
    });
    const onRoad = liveAssignments
      .filter((a) => a.request?.carRequest)
      .map((a) => {
        const plannedEnd = new Date(a.request.carRequest!.endDate);
        const eta = a.estimatedReturnAt ? new Date(a.estimatedReturnAt) : null;
        return {
          requestId: a.request.id,
          docNumber: a.request.docNumber,
          vehicle: a.vehicle?.vehicleNo ?? '—',
          driver: a.driver?.name ?? null,
          destination: a.request.carRequest!.destination,
          plannedEnd,
          estimatedReturnAt: a.estimatedReturnAt,
          tripStarted: a.trip?.status === 'STARTED',
          overdue: (eta ?? plannedEnd) < now,
        };
      });

    const today = await this.prisma.carRequest.findMany({
      where: {
        request: { status: { in: ['APPROVED', 'IN_PROGRESS'] as WorkflowStatus[] } },
        startDate: { lt: dayEnd },
        endDate: { gte: dayStart },
        vehicleId: { not: null },
      },
      orderBy: { startDate: 'asc' },
      select: {
        requestId: true,
        startDate: true,
        endDate: true,
        destination: true,
        vehicle: { select: { vehicleNo: true } },
        driver: { select: { name: true } },
        assignment: { select: { driverNotedAt: true, driverArrivedAt: true, driverBackAtOfficeAt: true, estimatedReturnAt: true } },
        request: { select: { id: true, docNumber: true, status: true } },
      },
    });

    const blocked = await this.prisma.vehicleUnavailability.findMany({
      where: { status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } },
      include: { vehicle: { select: { vehicleNo: true, brandModel: true } } },
      orderBy: { endsAt: 'asc' },
    });

    return {
      onRoad,
      delayedCount: onRoad.filter((t) => t.estimatedReturnAt && new Date(t.estimatedReturnAt) > t.plannedEnd).length,
      today: today.map((t) => ({
        requestId: t.request.id,
        docNumber: t.request.docNumber,
        status: t.request.status,
        startDate: t.startDate,
        endDate: t.endDate,
        destination: t.destination,
        vehicle: t.vehicle?.vehicleNo ?? '—',
        driver: t.driver?.name ?? null,
        notedAt: t.assignment?.driverNotedAt ?? null,
        readyAt: t.assignment?.driverArrivedAt ?? null,
        backAt: t.assignment?.driverBackAtOfficeAt ?? null,
        estimatedReturnAt: t.assignment?.estimatedReturnAt ?? null,
      })),
      blocked: blocked.map((u) => ({
        vehicle: u.vehicle?.vehicleNo ?? '—',
        brandModel: u.vehicle?.brandModel ?? '',
        startsAt: u.startsAt,
        endsAt: u.endsAt,
        reason: u.reason || 'Unavailable',
      })),
      generatedAt: now,
    };
  }

  /**
   * Administration queue: car requests that are APPROVED but still have no vehicle
   * assigned (carRequest.vehicleId is cleared on release too, so re-released
   * requests reappear here automatically).
   * Requests whose window ended >24h ago are HIDDEN — the 07:00 cron expires
   * them shortly after; serving them would book a car for a ride that cannot
   * happen (the rider forgot to cancel).
   */
  async listApprovedUnassigned() {
    return this.prisma.requestDocument.findMany({
      where: {
        docType: 'CAR_REQUEST',
        status: 'APPROVED',
        carRequest: { vehicleId: null, endDate: { gt: new Date(Date.now() - 24 * 3600 * 1000) } },
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        requester: { select: { username: true, fullName: true } },
        department: { select: { name: true } },
        carRequest: {
          select: { destination: true, startDate: true, endDate: true, vehicleTypeRequired: true, passengers: true },
        },
      },
    });
  }

  /** List assignments for Administration processing views. */
  listAssignments(activeOnly = false) {
    return this.prisma.carAssignment.findMany({
      where: activeOnly ? { releasedAt: null } : undefined,
      orderBy: { assignedAt: 'desc' },
      include: {
        request: { select: { docNumber: true, title: true, status: true } },
        vehicle: { select: { vehicleNo: true, brandModel: true } },
        driver: { select: { name: true } },
        trip: true,
      },
    });
  }

  // ---------- trips ----------

  async startTrip(requestId: string, data: { startMileage: number }, actor: Actor) {
    const assignment = await this.prisma.carAssignment.findUnique({
      where: { requestId },
      include: { vehicle: true, trip: true },
    });
    if (!assignment) throw new NotFoundException('No assignment for this request');
    if (assignment.trip) throw new ConflictException('Trip already exists for this assignment');
    if (data.startMileage < assignment.vehicle.currentMileage) {
      throw new BadRequestException(
        `Start mileage (${data.startMileage}) cannot be less than current odometer (${assignment.vehicle.currentMileage})`,
      );
    }

    const trip = await this.prisma.$transaction(async (tx) => {
      const t = await tx.carTrip.create({
        data: {
          assignmentId: assignment.id,
          status: 'STARTED',
          startMileage: data.startMileage,
          startedAt: new Date(),
        },
      });
      await tx.vehicle.update({
        where: { id: assignment.vehicleId },
        data: { currentMileage: data.startMileage },
      });
      return t;
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TRIP_STARTED', module: 'CARS', recordId: requestId,
      newValue: { startMileage: data.startMileage },
    });
    return trip;
  }

  async completeTrip(requestId: string, data: { endMileage: number; remarks?: string }, actor: Actor) {
    const assignment = await this.prisma.carAssignment.findUnique({
      where: { requestId },
      include: { vehicle: true, trip: true },
    });
    if (!assignment?.trip) throw new NotFoundException('Trip not started for this request');
    if (assignment.trip.status !== 'STARTED') {
      throw new BadRequestException(`Cannot complete trip from status ${assignment.trip.status}`);
    }
    if (data.endMileage < (assignment.trip.startMileage ?? 0)) {
      throw new BadRequestException(
        `End mileage (${data.endMileage}) cannot be less than start mileage (${assignment.trip.startMileage})`,
      );
    }

    const distance = data.endMileage - (assignment.trip.startMileage ?? 0);

    const trip = await this.prisma.$transaction(async (tx) => {
      const t = await tx.carTrip.update({
        where: { id: assignment.trip!.id },
        data: {
          status: 'COMPLETED',
          endMileage: data.endMileage,
          completedAt: new Date(),
          remarks: data.remarks,
        },
      });
      // Only free the vehicle if no other active assignment took it meanwhile
      // (e.g. driver signalled "Back at Office" on Telegram and Administration
      // already re-assigned the car to a new trip before this completion).
      const otherActive = await tx.carAssignment.count({
        where: { vehicleId: assignment.vehicleId, id: { not: assignment.id }, releasedAt: null },
      });
      await tx.vehicle.update({
        where: { id: assignment.vehicleId },
        data: { currentMileage: data.endMileage, ...(otherActive === 0 ? { status: 'AVAILABLE' as const } : {}) },
      });
      await tx.carRequest.update({ where: { requestId }, data: { status: 'COMPLETED' } });
      await tx.requestDocument.update({ where: { id: requestId }, data: { status: 'COMPLETED' } });
      if (assignment.driverId) {
        await tx.driver.update({ where: { id: assignment.driverId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
      }
      return t;
    });

    await this.notifications.notify({
      userId: (await this.prisma.requestDocument.findUnique({ where: { id: requestId }, select: { requesterId: true } }))!.requesterId,
      type: 'TRIP_COMPLETED',
      title: `Trip completed for ${(await this.prisma.requestDocument.findUnique({ where: { id: requestId }, select: { docNumber: true } }))!.docNumber}`,
      body: `Distance: ${distance} km`,
      link: `/requests/${requestId}`, requestId,
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TRIP_COMPLETED', module: 'CARS', recordId: requestId,
      oldValue: { status: 'STARTED' },
      newValue: { endMileage: data.endMileage, distance },
    });
    return trip;
  }

  // ---------- expenses ----------

  /**
   * Expense access rule: Administration (cars.assign) manages fleet spending, and
   * the requester may add/view expenses for their OWN trip (e.g. fuel paid in cash).
   * Everyone else is forbidden — without this guard any logged-in user could read
   * and write expenses on ANY request by id (no controller-level guard existed).
   */
  private async assertExpenseAccess(requestId: string, actor: Actor) {
    const request = await this.prisma.requestDocument.findUnique({
      where: { id: requestId },
      select: { requesterId: true },
    });
    if (!request) throw new NotFoundException('Car request not found');
    if (request.requesterId === actor.userId) return; // the owner always has access
    if (await this.permissions.userHas(actor.userId, 'cars.assign')) return; // Administration
    throw new ForbiddenException('Only Administration or the requester can access trip expenses');
  }

  async addExpense(requestId: string, data: {
    type: string; amount: number; description?: string; expenseDate?: string;
  }, actor: Actor) {
    await this.assertExpenseAccess(requestId, actor);
    const assignment = await this.prisma.carAssignment.findUnique({
      where: { requestId },
      include: { trip: true },
    });
    if (!assignment?.trip) throw new NotFoundException('Trip not started for this request');

    if (!data.amount || data.amount <= 0) throw new BadRequestException('Amount must be positive');

    const expense = await this.prisma.carExpense.create({
      data: {
        tripId: assignment.trip.id,
        vehicleId: assignment.vehicleId,
        type: data.type as never,
        amount: new Prisma.Decimal(data.amount),
        description: data.description,
        expenseDate: data.expenseDate ? new Date(data.expenseDate) : new Date(),
        createdById: actor.userId,
      },
    });

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'CAR_EXPENSE_ADDED', module: 'CARS', recordId: expense.id,
      newValue: { requestId, type: data.type, amount: data.amount },
    });
    return expense;
  }

  async listExpenses(requestId: string, actor: Actor) {
    await this.assertExpenseAccess(requestId, actor);
    const assignment = await this.prisma.carAssignment.findUnique({ where: { requestId }, include: { trip: true } });
    if (!assignment?.trip) return [];
    return this.prisma.carExpense.findMany({
      where: { tripId: assignment.trip.id },
      orderBy: { expenseDate: 'desc' },
    });
  }
}
