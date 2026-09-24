import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TripStatus, WorkflowStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { PermissionsService } from '../auth/permissions.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.service';
import { TelegramService } from '../telegram/telegram.service';
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
  }, actor: Actor) {
    const startDate = new Date(data.startDate);
    // End optional: same-day 17:00 default (most requests are single-day trips)
    const endDate = data.endDate ? new Date(data.endDate) : new Date(startDate);
    if (!data.endDate) endDate.setHours(17, 0, 0, 0);
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
    return car;
  }

  /** Update car details while still DRAFT. */
  async updateCarRequest(requestId: string, data: {
    destination?: string; purpose?: string; startDate?: string; endDate?: string;
    passengers?: number; vehicleTypeRequired?: string; timeSlot?: string; pickupLocation?: string;
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
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: data.endDate ? new Date(data.endDate) : undefined,
      },
    });
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

    const [vehicles, bookings] = await Promise.all([
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
        },
        select: {
          vehicleId: true,
          startDate: true,
          endDate: true,
          request: { select: { docNumber: true } },
        },
        orderBy: { startDate: 'asc' },
      }),
    ]);

    return vehicles.map((v) => ({
      ...v,
      bookings: bookings
        .filter((b) => b.vehicleId === v.id)
        .map((b) => ({ docNumber: b.request?.docNumber, startDate: b.startDate, endDate: b.endDate })),
    }));
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
        request: { select: { docNumber: true } },
      },
      orderBy: { startDate: 'asc' },
      take: 10,
    });
    return { conflicts };
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
        endDate: { gt: start },
      },
      select: { requestId: true, startDate: true, endDate: true, request: { select: { docNumber: true } } },
    });
    return { available: conflicts.length === 0, conflicts };
  }

  /** Administration assigns vehicle (+ optional driver) to an APPROVED car request. */
  async assign(requestId: string, data: { vehicleId: string; driverId?: string }, actor: Actor) {
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

    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: data.vehicleId } });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.status === 'OUT_OF_SERVICE' || vehicle.status === 'UNDER_MAINTENANCE') {
      throw new ConflictException(`Vehicle ${vehicle.vehicleNo} is ${vehicle.status}`);
    }

    // planned-absence guard: a driver with ACTIVE absence covering the trip window cannot be assigned
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

    const assignment = await this.prisma.$transaction(async (tx) => {
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
      if (conflicts.length > 0) {
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
        data: { vehicleId: data.vehicleId, driverId: data.driverId, status: 'IN_PROGRESS' },
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

    await this.notifications.notify({
      userId: request.requesterId,
      type: 'CAR_ASSIGNED',
      title: `Vehicle assigned to ${request.docNumber}`,
      body: `${vehicle.vehicleNo} (${vehicle.brandModel}) has been assigned for your trip.`,
      link: `/requests/${requestId}`, requestId,
    });

    // Telegram route message to the driver (silent no-op when token unset/disabled;
    // fire-and-forget so a slow/unreachable Telegram never delays the assignment)
    this.telegram.sendAssignment(assignment.id).catch(() => undefined);

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'CAR_ASSIGNED', module: 'CARS', recordId: requestId,
      newValue: { vehicleId: data.vehicleId, driverId: data.driverId },
    });

    return assignment;
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
        data: { vehicleId: data.vehicleId, driverId: data.driverId ?? null },
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
    await this.notifications.notify({
      userId: request.requesterId,
      type: 'CAR_ASSIGNED',
      title: `Assignment changed for ${request.docNumber}`,
      body: [
        vehicleChanged ? `Vehicle: ${prevVehicleLabel} → ${vehicle.vehicleNo} (${vehicle.brandModel})` : null,
        driverChanged ? 'Driver has been updated.' : null,
        `Schedule: ${carReq.startDate.toLocaleString('en-GB')} → ${carReq.endDate.toLocaleString('en-GB')} (unchanged unless you were told otherwise).`,
      ].filter(Boolean).join(' · '),
      link: `/requests/${requestId}`, requestId,
    });
    // NEW driver holds an AMS account in some setups — mirror a bell notification too
    if (driverChanged && data.driverId) {
      const driverUser = await this.prisma.driver.findUnique({ where: { id: data.driverId }, select: { employee: { select: { user: { select: { id: true } } } } } });
      const newDriverUserId = driverUser?.employee?.user?.id;
      if (newDriverUserId) {
        await this.notifications.notify({
          userId: newDriverUserId,
          type: 'CAR_ASSIGNED',
          title: `You are the driver for ${request.docNumber}`,
          body: `${vehicle.vehicleNo} (${vehicle.brandModel}) · ${carReq.startDate.toLocaleString('en-GB')} → ${carReq.endDate.toLocaleString('en-GB')} · pickup ${carReq.pickupLocation ?? '—'} → ${carReq.destination}.`,
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
      await tx.carAssignment.update({ where: { id: assignment.id }, data: { releasedAt: new Date() } });
      await tx.carRequest.update({ where: { requestId }, data: { vehicleId: null, driverId: null, status: 'APPROVED' } });
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
          if (request.carRequest.driverId) {
            const otherTrips = await tx.carRequest.count({
              where: { driverId: request.carRequest.driverId, requestId: { not: requestId }, request: { status: { in: activeStates } } },
            });
            if (otherTrips === 0) {
              await tx.driver.update({ where: { id: request.carRequest.driverId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
            }
          }
        }
      }
      // release the assignment row (if any) so its booking window no longer blocks others
      if (request.carRequest?.assignment && request.carRequest.assignment.releasedAt === null) {
        await tx.carAssignment.update({ where: { id: request.carRequest.assignment.id }, data: { releasedAt: new Date() } });
      }
      // clear vehicle links + mirror the new status on the CarRequest row so
      // availability checks / fleet overview immediately stop counting this booking
      await tx.carRequest.update({
        where: { requestId },
        data: { vehicleId: null, driverId: null, status: 'CANCELLED' },
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

  async adminShiftTime(requestId: string, data: { startDate: string; endDate: string; comment?: string }, actor: Actor) {
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
    const end = new Date(data.endDate);
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
      body: `New schedule: ${start.toLocaleString()} → ${end.toLocaleString()}.${data.comment ? ` Note: ${data.comment}` : ''}`,
      link: `/requests/${requestId}`, requestId,
    });
    // the assigned driver holds no AMS account — tell them on Telegram directly
    if (request.carRequest?.driverId) {
      await this.telegram.notifyDriverOfTimeChange(requestId, request.docNumber, request.carRequest.driverId, start, end, data.comment).catch(() => undefined);
    }
    return { success: true };
  }

  /**
   * Administration queue: car requests that are APPROVED but still have no vehicle
   * assigned (carRequest.vehicleId is cleared on release too, so re-released
   * requests reappear here automatically).
   */
  async listApprovedUnassigned() {
    return this.prisma.requestDocument.findMany({
      where: {
        docType: 'CAR_REQUEST',
        status: 'APPROVED',
        carRequest: { vehicleId: null },
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
