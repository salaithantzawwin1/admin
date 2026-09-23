import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DriverStatus, Prisma, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { Actor } from '../org/org.service';

@Injectable()
export class FleetService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private telegram: TelegramService,
    private notifications: NotificationsService,
  ) {}

  // ---------- vehicles ----------
  listVehicles(status?: VehicleStatus) {
    return this.prisma.vehicle.findMany({
      where: status ? { status } : undefined,
      orderBy: { vehicleNo: 'asc' },
      include: { driver: true },
    });
  }

  async createVehicle(data: {
    vehicleNo: string; vehicleType: string; brandModel: string; capacity?: number;
    driverId?: string; registrationExpiry?: string; insuranceExpiry?: string; notes?: string;
  }, actor: Actor) {
    const exists = await this.prisma.vehicle.findUnique({ where: { vehicleNo: data.vehicleNo } });
    if (exists) throw new BadRequestException('Vehicle number already exists');

    const vehicle = await this.prisma.vehicle.create({
      data: {
        vehicleNo: data.vehicleNo,
        vehicleType: data.vehicleType as never,
        brandModel: data.brandModel,
        capacity: data.capacity,
        driverId: data.driverId,
        registrationExpiry: data.registrationExpiry ? new Date(data.registrationExpiry) : undefined,
        insuranceExpiry: data.insuranceExpiry ? new Date(data.insuranceExpiry) : undefined,
        notes: data.notes,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_CREATED', module: 'FLEET', recordId: vehicle.id,
      newValue: { vehicleNo: vehicle.vehicleNo },
    });
    return vehicle;
  }

  async updateVehicle(id: string, data: {
    brandModel?: string; capacity?: number; driverId?: string | null; status?: string;
    registrationExpiry?: string; insuranceExpiry?: string; notes?: string; currentMileage?: number;
  }, actor: Actor) {
    const old = await this.prisma.vehicle.findUnique({ where: { id }, include: { driver: { select: { name: true } } } });
    if (!old) throw new NotFoundException('Vehicle not found');

    // driverId: null or "" = clear ("blank"), undefined = unchanged, string = reassign (must exist)
    let driverId: string | null | undefined = data.driverId === null || data.driverId === '' ? null : data.driverId;
    if (driverId) {
      const driver = await this.prisma.driver.findUnique({ where: { id: driverId }, select: { id: true } });
      if (!driver) throw new BadRequestException('Driver not found');
    }

    const vehicle = await this.prisma.vehicle.update({
      where: { id },
      include: { driver: { select: { name: true } } },
      data: {
        brandModel: data.brandModel,
        capacity: data.capacity,
        driverId,
        status: data.status as VehicleStatus | undefined,
        registrationExpiry: data.registrationExpiry ? new Date(data.registrationExpiry) : undefined,
        insuranceExpiry: data.insuranceExpiry ? new Date(data.insuranceExpiry) : undefined,
        notes: data.notes,
        currentMileage: data.currentMileage,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_UPDATED', module: 'FLEET', recordId: id,
      oldValue: { status: old.status, currentMileage: old.currentMileage, driver: old.driver?.name ?? null },
      newValue: { status: vehicle.status, currentMileage: vehicle.currentMileage, driver: vehicle.driver?.name ?? null },
    });
    return vehicle;
  }

  /**
   * Delete a vehicle. Blocked when assignment/expense/request history
   * exists (FK RESTRICT) — suggest OUT_OF_SERVICE instead so history
   * keeps its vehicle reference.
   */
  async deleteVehicle(id: string, actor: Actor) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
      include: { _count: { select: { assignments: true, expenses: true, carRequests: true } } },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const used = vehicle._count.assignments + vehicle._count.expenses + vehicle._count.carRequests;
    if (used > 0) {
      throw new BadRequestException(
        `Cannot delete ${vehicle.vehicleNo}: it has ${used} related record(s) (assignments/expenses/requests). Set it to OUT_OF_SERVICE instead to keep history intact.`,
      );
    }

    await this.prisma.vehicle.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_DELETED', module: 'FLEET', recordId: id,
      oldValue: { vehicleNo: vehicle.vehicleNo },
    });
    return { ok: true };
  }

  // ---------- drivers ----------
  listDrivers(status?: DriverStatus) {
    // telegramBindCode deliberately excluded — it is a linking secret (see listTelegramBindings)
    return this.prisma.driver.findMany({
      where: status ? { status } : undefined,
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, phone: true, licenseNo: true, licenseExpiry: true,
        status: true, notes: true, telegramChatId: true, telegramUsername: true, createdAt: true, updatedAt: true,
        vehicles: { select: { vehicleNo: true } },
        employee: { select: { id: true, employeeNo: true, fullName: true } },
        absences: { where: { status: 'ACTIVE', endsAt: { gt: new Date() } }, select: { startsAt: true, endsAt: true, reason: true } },
      },
    });
  }

  /** Telegram binding state per driver — bind codes are admin-only (fleet.manage). */
  listTelegramBindings() {
    return this.prisma.driver.findMany({
      select: { id: true, telegramChatId: true, telegramBindCode: true },
    });
  }

  /** Regenerate the Telegram bind code for a driver — the driver then sends
   *  "/start <code>" to the AMS bot to link their chat. Unlinks any previous chat. */
  async regenerateBindCode(id: string, actor: Actor) {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException('Driver not found');
    const code = await this.telegram.regenerateBindCode(id);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_BIND_CODE_GENERATED', module: 'FLEET', recordId: id,
      newValue: { driver: driver.name },
    });
    return { code };
  }

  async createDriver(data: { name: string; phone?: string; licenseNo?: string; licenseExpiry?: string; notes?: string; employeeId?: string }, actor: Actor) {
    const driver = await this.prisma.driver.create({
      data: {
        name: data.name,
        phone: data.phone,
        licenseNo: data.licenseNo,
        licenseExpiry: data.licenseExpiry ? new Date(data.licenseExpiry) : undefined,
        notes: data.notes,
        employeeId: data.employeeId || undefined,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_CREATED', module: 'FLEET', recordId: driver.id,
      newValue: { name: driver.name },
    });
    return driver;
  }

  async updateDriver(id: string, data: {
    name?: string; phone?: string | null; licenseNo?: string | null; licenseExpiry?: string;
    status?: string; notes?: string;
  }, actor: Actor) {
    return this.updateDriverCore(id, data, actor);
  }

  /** Link this driver to an employee record (driver = a staff member). */
  async linkEmployee(id: string, employeeId: string, actor: Actor) {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) throw new NotFoundException('Employee not found');
    const clash = await this.prisma.driver.findFirst({ where: { employeeId, id: { not: id } } });
    if (clash) throw new ConflictException(`Employee ${employee.fullName} is already linked to driver "${clash.name}" — unlink that one first`);
    const driver = await this.prisma.driver.update({
      where: { id },
      data: { employeeId },
      include: { employee: { select: { id: true, employeeNo: true, fullName: true } } },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_EMPLOYEE_LINKED', module: 'FLEET', recordId: id,
      newValue: { driver: driver.name, employee: employee.fullName, employeeNo: employee.employeeNo },
    });
    return driver;
  }

  /** Remove the driver ↔ employee link. */
  async unlinkEmployee(id: string, actor: Actor) {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException('Driver not found');
    if (!driver.employeeId) throw new BadRequestException('This driver has no employee link');
    const updated = await this.prisma.driver.update({
      where: { id },
      data: { employeeId: null },
      include: { employee: { select: { id: true, employeeNo: true, fullName: true } } },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_EMPLOYEE_UNLINKED', module: 'FLEET', recordId: id,
      oldValue: { driver: driver.name, employeeId: driver.employeeId },
    });
    return updated;
  }

  /**
   * Correlated assignment history for a linked driver+employee pair —
   * assignments made under EITHER record appear once, merged by time.
   */
  async correlatedHistory(id: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { id },
      include: { employee: { select: { id: true, employeeNo: true, fullName: true } } },
    });
    if (!driver) throw new NotFoundException('Driver not found');
    // correlate via the employee's system-user account (their submitted car requests)
    const empUserId = (await this.prisma.employee.findUnique({ where: { id: driver.employeeId ?? '00000000-0000-0000-0000-000000000000' }, select: { userId: true } }))?.userId;
    const carReqIds = empUserId
      ? (await this.prisma.carRequest.findMany({ where: { request: { requesterId: empUserId } }, select: { requestId: true } })).map((c) => c.requestId)
      : [];
    const where: Prisma.CarAssignmentWhereInput = carReqIds.length
      ? { OR: [{ driverId: id }, { requestId: { in: carReqIds } }] }
      : { driverId: id };
    const rows = await this.prisma.carAssignment.findMany({
      where,
      orderBy: { assignedAt: 'desc' },
      take: 50,
      include: {
        vehicle: { select: { vehicleNo: true, brandModel: true } },
        driver: { select: { id: true, name: true } },
        request: {
          select: { docNumber: true, status: true, requester: { select: { fullName: true } } },
        },
      },
    });
    return {
      driver: { id: driver.id, name: driver.name },
      employee: driver.employee,
      assignments: rows.map((a) => ({
        id: a.id,
        assignedAt: a.assignedAt,
        docNumber: a.request.docNumber,
        requester: a.request.requester.fullName,
        vehicle: a.vehicle.vehicleNo,
        brandModel: a.vehicle.brandModel,
        status: a.request.status,
        driver: a.driver?.name ?? null,
        driverNotedAt: a.driverNotedAt,
        driverArrivedAt: a.driverArrivedAt,
        driverBackAtOfficeAt: a.driverBackAtOfficeAt,
        /** true when this row exists because of the employee link, not the driver */
        viaEmployee: a.driverId !== id,
      })),
    };
  }

  private async updateDriverCore(id: string, data: {
    name?: string; phone?: string | null; licenseNo?: string | null; licenseExpiry?: string;
    status?: string; notes?: string;
  }, actor: Actor) {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException('Driver not found');

    const updated = await this.prisma.driver.update({
      where: { id },
      data: {
        name: data.name,
        // null clears ("blank"), undefined leaves unchanged
        phone: data.phone === null ? null : data.phone,
        licenseNo: data.licenseNo === null ? null : data.licenseNo,
        licenseExpiry: data.licenseExpiry ? new Date(data.licenseExpiry) : undefined,
        status: data.status as DriverStatus | undefined,
        notes: data.notes,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_UPDATED', module: 'FLEET', recordId: id,
      oldValue: { status: driver.status }, newValue: { status: updated.status },
    });
    return updated;
  }

  /**
   * Delete a driver. Blocked when trip/assignment history exists —
   * suggest INACTIVE instead. Vehicle links (vehicles.driverId) are
   * cleared automatically by ON DELETE SET NULL.
   */
  async deleteDriver(id: string, actor: Actor) {
    const driver = await this.prisma.driver.findUnique({
      where: { id },
      include: { _count: { select: { carRequests: true, carAssignments: true } } },
    });
    if (!driver) throw new NotFoundException('Driver not found');

    const used = driver._count.carRequests + driver._count.carAssignments;
    if (used > 0) {
      throw new BadRequestException(
        `Cannot delete ${driver.name}: ${used} related trip record(s) exist. Set status to INACTIVE instead to keep history intact.`,
      );
    }

    await this.prisma.driver.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_DELETED', module: 'FLEET', recordId: id,
      oldValue: { name: driver.name },
    });
    return { ok: true };
  }

  /** Vehicle 360: assignments + trips + expenses + upcoming bookings. */
  async vehicleDetail(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
      include: { driver: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const [assignments, trips, expenses, upcoming] = await Promise.all([
      this.prisma.carAssignment.findMany({
        where: { vehicleId: id },
        orderBy: { assignedAt: 'desc' },
        take: 20,
        include: { request: { include: { requester: { select: { fullName: true } } } }, trip: true },
      }),
      this.prisma.carTrip.findMany({
        where: { assignment: { vehicleId: id } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.carExpense.findMany({
        where: { vehicleId: id },
        orderBy: { expenseDate: 'desc' },
        take: 20,
      }),
      this.prisma.carRequest.findMany({
        where: {
          vehicleId: id,
          startDate: { gte: new Date() },
          status: { in: ['APPROVED', 'PENDING_APPROVAL'] },
        },
        orderBy: { startDate: 'asc' },
        take: 10,
        include: { request: { select: { docNumber: true } } },
      }),
    ]);

    return { vehicle, assignments, trips, expenses, upcoming };
  }

  // ---------- driver absences (planned non-availability) ----------

  /** All absences — active/upcoming by default; pass all=true to include cancelled. */
  listAbsences(all = false) {
    return this.prisma.driverAbsence.findMany({
      where: all ? undefined : { status: 'ACTIVE' },
      orderBy: { startsAt: 'asc' },
      take: 200,
      include: { driver: { select: { id: true, name: true } } },
    });
  }

  /** Record a planned absence — auto-flips the driver to ON_LEAVE when it starts today/now. */
  async createAbsence(
    data: { driverId: string; startsAt: Date; endsAt: Date; reason?: string },
    actor: { userId: string; username: string },
  ) {
    const driver = await this.prisma.driver.findUnique({ where: { id: data.driverId } });
    if (!driver) throw new NotFoundException('Driver not found');
    if (!(data.endsAt > data.startsAt)) throw new BadRequestException('Absence end must be after start');
    // overlapping ACTIVE absence for the same driver is a mistake (double entry)
    const overlap = await this.prisma.driverAbsence.findFirst({
      where: { driverId: data.driverId, status: 'ACTIVE', startsAt: { lt: data.endsAt }, endsAt: { gt: data.startsAt } },
      select: { id: true, startsAt: true, endsAt: true },
    });
    if (overlap) throw new ConflictException(`Driver already has an absence ${overlap.startsAt.toISOString().slice(0, 10)} → ${overlap.endsAt.toISOString().slice(0, 10)}`);
    // future trips already assigned to this driver inside the window — warn loudly
    const trips = await this.prisma.carRequest.findMany({
      where: { driverId: data.driverId, startDate: { lt: data.endsAt }, endDate: { gt: data.startsAt }, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] } },
      select: { requestId: true, request: { select: { docNumber: true } } },
    });

    const absence = await this.prisma.driverAbsence.create({
      data: {
        driverId: data.driverId,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        reason: data.reason,
        createdById: actor.userId,
      },
    });
    // already started (recording a same-day absence) → flip status now
    if (data.startsAt <= new Date() && driver.status === 'AVAILABLE') {
      await this.prisma.driver.update({ where: { id: driver.id }, data: { status: 'ON_LEAVE' } });
    }

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_ABSENCE_RECORDED', module: 'FLEET', recordId: absence.id,
      newValue: { driver: driver.name, startsAt: data.startsAt, endsAt: data.endsAt, reason: data.reason ?? null },
    });

    // tell Administration — especially important when future trips clash
    const admins = await this.prisma.userRole.findMany({
      where: { role: { name: { in: ['ADMINISTRATION', 'SYSTEM_ADMIN'] } }, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    const adminIds = [...new Set(admins.map((r) => r.userId))];
    if (adminIds.length) {
      const clash = trips.length ? ` ⚠️ ${trips.length} assigned trip(s) fall inside this window (${trips.map((t) => t.request.docNumber).join(', ')}) — re-assign them.` : '';
      await this.notifications.notifyMany(adminIds, {
        type: 'REMINDER' as never,
        title: `🗓 Driver absence — ${driver.name}`,
        body: `${driver.name} is absent ${data.startsAt.toISOString().slice(0, 10)} → ${data.endsAt.toISOString().slice(0, 10)}${data.reason ? ` (${data.reason})` : ''}.${clash}`,
        link: '/fleet',
      });
    }
    return { ...absence, clashes: trips.map((t) => t.request.docNumber) };
  }

  /** Cancel a planned absence — driver returns to AVAILABLE (if not on a trip). */
  async cancelAbsence(id: string, actor: { userId: string; username: string }) {
    const absence = await this.prisma.driverAbsence.findUnique({ where: { id }, include: { driver: true } });
    if (!absence) throw new NotFoundException('Absence not found');
    if (absence.status !== 'ACTIVE') throw new BadRequestException('Absence already cancelled');
    await this.prisma.$transaction([
      this.prisma.driverAbsence.update({ where: { id }, data: { status: 'CANCELLED' } }),
      // restore status only when the window is current and the driver is not on a trip
      ...(absence.startsAt <= new Date() && absence.endsAt > new Date() && absence.driver.status === 'ON_LEAVE'
        ? [this.prisma.driver.update({ where: { id: absence.driverId }, data: { status: 'AVAILABLE' } })]
        : []),
    ]);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_ABSENCE_CANCELLED', module: 'FLEET', recordId: id,
      oldValue: { driver: absence.driver.name, startsAt: absence.startsAt, endsAt: absence.endsAt },
    });
    return { ok: true };
  }

  /**
   * Cron: keep driver status in step with absences — flip to ON_LEAVE when a
   * window starts, back to AVAILABLE when it ends (never touching ON_TRIP or
   * INACTIVE drivers). Idempotent by construction (status checks in where).
   */
  @Cron('0 5 * * * *') // five past every hour
  async syncAbsenceStatuses() {
    const now = new Date();
    // windows that just started → ON_LEAVE
    const starting = await this.prisma.driverAbsence.findMany({
      where: { status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } },
      include: { driver: { select: { id: true, status: true } } },
    });
    for (const a of starting) {
      if (a.driver.status === 'AVAILABLE') {
        await this.prisma.driver.update({ where: { id: a.driverId }, data: { status: 'ON_LEAVE' } }).catch(() => undefined);
      }
    }
    // windows that ended → AVAILABLE (skip drivers now on a trip / inactive)
    const ended = await this.prisma.driverAbsence.findMany({
      where: { status: 'ACTIVE', endsAt: { lte: now } },
      include: { driver: { select: { id: true, status: true } } },
    });
    for (const a of ended) {
      if (a.driver.status === 'ON_LEAVE') {
        await this.prisma.driver.update({ where: { id: a.driverId }, data: { status: 'AVAILABLE' } }).catch(() => undefined);
      }
    }
  }
}
