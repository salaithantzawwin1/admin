import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DriverStatus, Prisma, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { PermissionsService } from '../auth/permissions.service';
import { PERMISSIONS } from '../auth/permissions';
import { TimetableService } from '../settings/timetable.service';
import { EventsService } from '../events/events.service';
import { Actor } from '../org/org.service';

/** Leave granularity against the Company Time Table. */
export type AbsenceDayType = 'FULL' | 'HALF';
export type AbsencePeriod = 'FULL_DAY' | 'MORNING' | 'EVENING';

// ---------- document expiry (VMS spec §6.3 — Phase A) ----------

/** Business-local calendar date ('YYYY-MM-DD') in the organization timezone.
 *  Spec §6.3: browser/UTC-local time must never be the source of truth for
 *  expiry math — 'en-CA' formatting yields an ISO date part that compares
 *  lexicographically = chronologically. */
const EXPIRY_TZ = 'Asia/Yangon';
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: EXPIRY_TZ }).format(d);

/** Warning thresholds (calendar days before expiry) — spec §6.4 defaults. */
export const EXPIRY_WARNING_DAYS = [30, 14, 7, 1] as const;

export type ExpiryStatus = 'EXPIRED' | 'DUE_TODAY' | 'UPCOMING' | 'VALID';

/** Single server-side status calculation shared by the vehicle/driver lists,
 *  the dashboard feed and the daily alert job. Returns null when no date is
 *  set (field-level NOT_CONFIGURED — Phase B's document types decide whether
 *  a missing document is a violation). */
export function expiryStatus(expiry: Date | null | undefined, now: Date = new Date()): ExpiryStatus | null {
  if (!expiry) return null;
  const today = ymd(now);
  const exp = ymd(expiry);
  if (exp < today) return 'EXPIRED';
  if (exp === today) return 'DUE_TODAY';
  return (Date.parse(exp) - Date.parse(today)) / 86_400_000 <= 30 ? 'UPCOMING' : 'VALID';
}

/** Whole business-local days until expiry: 0 = today, negative = overdue. */
export function daysUntilExpiry(expiry: Date, now: Date = new Date()): number {
  return Math.round((Date.parse(ymd(expiry)) - Date.parse(ymd(now))) / 86_400_000);
}

export interface ExpiryAlert {
  kind: 'VEHICLE' | 'DRIVER';
  id: string;
  /** vehicleNo or driver name */
  label: string;
  doc: 'registration' | 'insurance' | 'license';
  docLabel: string;
  expiry: Date;
  status: 'EXPIRED' | 'DUE_TODAY' | 'UPCOMING';
  daysLeft: number;
}

/** Dedup key per §6.4: document + expiry date + threshold. The recipient is
 *  appended per notification (spec includes recipient in the key). */
const alertKey = (a: ExpiryAlert) =>
  `doc-expiry:${a.kind}:${a.id}:${a.doc}:${ymd(a.expiry)}:${a.status === 'UPCOMING' ? `d${a.daysLeft}` : a.status.toLowerCase()}`;

@Injectable()
export class FleetService {
  private readonly logger = new Logger(FleetService.name);
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private events: EventsService,
    private telegram: TelegramService,
    private notifications: NotificationsService,
    private permissions: PermissionsService,
    private timetable: TimetableService,
  ) {}

  // ---------- vehicle type master data (Plan §6) ----------

  /** All types for managers; pickers filter to active on the client. */
  listVehicleTypes() {
    return this.prisma.vehicleTypeMaster.findMany({ orderBy: { name: 'asc' } });
  }

  async createVehicleType(name: string, actor: Actor) {
    const exists = await this.prisma.vehicleTypeMaster.findUnique({ where: { name } });
    if (exists) throw new ConflictException(`Vehicle type "${name}" already exists`);
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(name)) {
      throw new BadRequestException('Use letters/numbers/underscore (e.g. STAFF_BUS) — stored uppercase like the existing list');
    }
    // keep the Postgres enum in sync so vehicles/requests can actually use the
    // new value (regex-validated name — safe to inline)
    try {
      await this.prisma.$executeRawUnsafe(`ALTER TYPE "VehicleType" ADD VALUE IF NOT EXISTS '${name}'`);
    } catch (e) {
      console.error(`[fleet] could not extend VehicleType enum with '${name}':`, (e as Error).message);
    }
    const type = await this.prisma.vehicleTypeMaster.create({ data: { name } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_TYPE_CREATED', module: 'FLEET', recordId: type.id,
      newValue: { name: type.name },
    });
    return type;
  }

  /** Toggle active (hide from pickers). Renames are not allowed — the name
   *  is the enum value stored on vehicles/requests. */
  async updateVehicleType(id: string, data: { active?: boolean }, actor: Actor) {
    const type = await this.prisma.vehicleTypeMaster.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('Vehicle type not found');
    const updated = await this.prisma.vehicleTypeMaster.update({ where: { id }, data: { active: data.active } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_TYPE_UPDATED', module: 'FLEET', recordId: id,
      oldValue: { active: type.active }, newValue: { active: updated.active },
    });
    return updated;
  }

  /**
   * Delete only when no vehicle or car request uses the type —
   * otherwise deactivate it so history stays intact.
   */
  async deleteVehicleType(id: string, actor: Actor) {
    const type = await this.prisma.vehicleTypeMaster.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('Vehicle type not found');
    const countEnum = async (field: 'vehicleType' | 'vehicleTypeRequired') => {
      try {
        return field === 'vehicleType'
          ? await this.prisma.vehicle.count({ where: { vehicleType: type.name as never } })
          : await this.prisma.carRequest.count({ where: { vehicleTypeRequired: type.name as never } });
      } catch {
        // a name that is not (yet) a Postgres enum value cannot exist in an
        // enum column — treat as unused
        return 0;
      }
    };
    const [vehicles, requests] = await Promise.all([countEnum('vehicleType'), countEnum('vehicleTypeRequired')]);
    if (vehicles + requests > 0) {
      throw new ConflictException(
        `Cannot delete "${type.name}": ${vehicles} vehicle(s) / ${requests} request(s) use it — deactivate it instead`,
      );
    }
    await this.prisma.vehicleTypeMaster.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_TYPE_DELETED', module: 'FLEET', recordId: id,
      oldValue: { name: type.name },
    });
    return { ok: true };
  }

  // ---------- vehicles ----------
  /**
   * Vehicle list with EFFECTIVE status. The DB column is written at ASSIGN time
   * (assign()/reassign() flip it to IN_USE), so it describes "committed to a
   * trip", not "physically on the road". The fleet table shows the physical
   * truth instead: a booking whose window covers now → IN_USE, maintenance
   * states kept, everything else AVAILABLE (future bookings stay listed as
   * booked windows elsewhere, they don't make the car "in use").
   */
  async listVehicles(status?: VehicleStatus) {
    const rows = await this.prisma.vehicle.findMany({
      where: status ? { status } : undefined,
      orderBy: { vehicleNo: 'asc' },
      include: { driver: true },
    });
    const now = new Date();
    const live = await this.prisma.carRequest.findMany({
      // same filter as requesterFleetOverview: base document status is the
      // single source of truth (CarRequest.status can stay DRAFT forever)
      where: {
        request: { status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as never[] } },
        startDate: { lte: now },
        endDate: { gte: now },
        vehicleId: { not: null },
      },
      select: { vehicleId: true },
    });
    const onRoad = new Set(live.map((r) => r.vehicleId as string));
    // a trip the driver STARTED that runs past its window must keep the car
    // IN_USE until the odometer close-out — otherwise a running-late ride
    // flashes AVAILABLE and someone else books the car mid-trip
    const startedTrips = await this.prisma.carAssignment.findMany({
      where: { releasedAt: null, trip: { status: 'STARTED' } },
      select: { vehicleId: true },
    });
    const started = new Set(startedTrips.map((t) => t.vehicleId));
    return rows.map((v) => ({
      ...v,
      status: onRoad.has(v.id) || started.has(v.id)
        ? 'IN_USE'
        : v.status === 'IN_USE'
          ? 'AVAILABLE'
          : v.status,
      // VMS spec §6.3 — shared server-side expiry status (lists, dashboard, alerts)
      registrationExpiryStatus: expiryStatus(v.registrationExpiry, now),
      insuranceExpiryStatus: expiryStatus(v.insuranceExpiry, now),
    }));
  }

  async createVehicle(data: {
    vehicleNo: string; vehicleType: string; brandModel: string; capacity?: number;
    driverId?: string; registrationExpiry?: string; insuranceExpiry?: string; notes?: string;
    vin?: string; fuelType?: string; engineNo?: string; chassisNo?: string; make?: string; model?: string; year?: number;
  }, actor: Actor) {
    const exists = await this.prisma.vehicle.findUnique({ where: { vehicleNo: data.vehicleNo } });
    if (exists) throw new BadRequestException('Vehicle number already exists');
    if (data.vin) {
      const vinTaken = await this.prisma.vehicle.findUnique({ where: { vin: data.vin } });
      if (vinTaken) throw new BadRequestException(`VIN already registered to ${vinTaken.vehicleNo}`);
    }

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
        vin: data.vin || null,
        fuelType: data.fuelType || null,
        engineNo: data.engineNo || null,
        chassisNo: data.chassisNo || null,
        make: data.make || null,
        model: data.model || null,
        year: data.year ?? null,
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
    brandModel?: string; vehicleType?: string; capacity?: number; driverId?: string | null; status?: string;
    registrationExpiry?: string | null; insuranceExpiry?: string | null; notes?: string; currentMileage?: number;
    vin?: string | null; fuelType?: string | null; engineNo?: string | null; chassisNo?: string | null;
    make?: string | null; model?: string | null; year?: number | null;
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
        // type is editable per-vehicle — the vehicle-type DELETE guard still
        // protects the master list, so in-use types cannot be orphaned
        ...(data.vehicleType ? { vehicleType: data.vehicleType as never } : {}),
        capacity: data.capacity,
        driverId,
        status: data.status as VehicleStatus | undefined,
        // null clears ("" handled by the frontend as null), undefined leaves unchanged
        registrationExpiry: data.registrationExpiry === null ? null : data.registrationExpiry ? new Date(data.registrationExpiry) : undefined,
        insuranceExpiry: data.insuranceExpiry === null ? null : data.insuranceExpiry ? new Date(data.insuranceExpiry) : undefined,
        notes: data.notes,
        currentMileage: data.currentMileage,
        // Tier 1: null clears the field, undefined leaves it unchanged ("" treated as clear)
        ...(data.vin === undefined ? {} : { vin: data.vin || null }),
        ...(data.fuelType === undefined ? {} : { fuelType: data.fuelType || null }),
        ...(data.engineNo === undefined ? {} : { engineNo: data.engineNo || null }),
        ...(data.chassisNo === undefined ? {} : { chassisNo: data.chassisNo || null }),
        ...(data.make === undefined ? {} : { make: data.make || null }),
        ...(data.model === undefined ? {} : { model: data.model || null }),
        ...(data.year === undefined ? {} : { year: data.year }),
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
   * Delete a vehicle.
   * Real usage (trip history, expenses, live assignments) still BLOCKS deletion
   * — suggest OUT_OF_SERVICE so history keeps its vehicle reference.
   * Leftovers from terminal workflows are cleaned up in the same transaction:
   * assignments whose request ended CANCELLED/REJECTED never became a ride
   * (e.g. CAR-202609-0007 on YGN-5678 — assigned then cancelled 19 min later),
   * so they are audit-log noise, not history worth keeping.
   */
  async deleteVehicle(id: string, actor: Actor) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
      include: {
        _count: { select: { assignments: true, expenses: true, carRequests: true } },
        assignments: { select: { id: true, requestId: true, request: { select: { status: true } } } },
      },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const expenses = vehicle._count.expenses;
    const live = vehicle.assignments.filter((a) => !['CANCELLED', 'REJECTED'].includes(a.request.status));
    const deadAssignmentIds = vehicle.assignments.filter((a) => ['CANCELLED', 'REJECTED'].includes(a.request.status)).map((a) => a.id);
    if (expenses > 0 || live.length > 0 || vehicle._count.carRequests > 0) {
      const used = expenses + live.length + vehicle._count.carRequests;
      throw new BadRequestException(
        `Cannot delete ${vehicle.vehicleNo}: it has ${used} related record(s) (assignments/expenses/requests). Set it to OUT_OF_SERVICE instead to keep history intact.`,
      );
    }

    await this.prisma.$transaction([
      // drop only the CANCELLED/REJECTED-only leftovers, then the vehicle itself
      ...(deadAssignmentIds.length
        ? [this.prisma.carAssignment.deleteMany({ where: { id: { in: deadAssignmentIds } } })]
        : []),
      this.prisma.vehicle.delete({ where: { id } }),
    ]);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_DELETED', module: 'FLEET', recordId: id,
      oldValue: { vehicleNo: vehicle.vehicleNo, droppedCancelledAssignments: deadAssignmentIds.length },
    });
    return { ok: true, droppedCancelledAssignments: deadAssignmentIds.length };
  }

  // ---------- drivers ----------
  /**
   * Drivers busy over a window (IN_PROGRESS assignments overlapping it and not
   * yet "Back at Office") — CarPanel and the Telegram picker both exclude them.
   */
  async busyDriverIds(start: Date, end: Date): Promise<string[]> {
    const rows = await this.prisma.carRequest.findMany({
      where: {
        status: 'IN_PROGRESS',
        driverId: { not: null },
        startDate: { lt: end },
        endDate: { gt: start },
        assignment: { releasedAt: null, driverBackAtOfficeAt: null },
      },
      select: { driverId: true },
    });
    return [...new Set(rows.map((r) => r.driverId).filter(Boolean) as string[])];
  }

  /**
   * Driver list with EFFECTIVE status — same window rule as listVehicles:
   * ON_TRIP in the DB can mean "booked for a LATER trip" (assign() flips it at
   * assignment time). ON_LEAVE / INACTIVE are physical/administrative states and
   * stay; a driver whose booked window covers now shows ON_TRIP, otherwise
   * AVAILABLE even when the DB still says ON_TRIP for a future ride.
   */
  async listDrivers(status?: DriverStatus) {
    const now = new Date();
    // telegramBindCode deliberately excluded — it is a linking secret (see listTelegramBindings)
    const rows = await this.prisma.driver.findMany({
      where: status ? { status } : undefined,
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, phone: true, licenseNo: true, licenseExpiry: true,
        status: true, notes: true, telegramChatId: true, telegramUsername: true, createdAt: true, updatedAt: true,
        vehicles: { select: { vehicleNo: true } },
        employee: { select: { id: true, employeeNo: true, fullName: true } },
        absences: { where: { status: 'ACTIVE', endsAt: { gt: now } }, select: { startsAt: true, endsAt: true, reason: true } },
      },
    });
    const live = await this.prisma.carRequest.findMany({
      where: {
        request: { status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as never[] } },
        startDate: { lte: now },
        endDate: { gte: now },
        driverId: { not: null },
      },
      select: { driverId: true },
    });
    const onRoad = new Set(live.map((r) => r.driverId as string));
    // same running-late rule as vehicles: a STARTED trip keeps the driver
    // ON_TRIP until the odometer close-out, window or not
    const startedTrips = await this.prisma.carAssignment.findMany({
      where: { releasedAt: null, trip: { status: 'STARTED' } },
      select: { driverId: true, estimatedReturnAt: true },
    });
    const started = new Set(startedTrips.map((t) => t.driverId).filter(Boolean) as string[]);
    // driver → live ⏰ ETA (only when the ETA is still in the future — an expired
    // one means the driver is overdue, which the escalations already surface)
    const etaByDriver = new Map(
      startedTrips
        .filter((t) => t.driverId && t.estimatedReturnAt && t.estimatedReturnAt > now)
        .map((t) => [t.driverId as string, t.estimatedReturnAt as Date]),
    );
    return rows.map((d) => ({
      ...d,
      status: onRoad.has(d.id) || started.has(d.id)
        ? 'ON_TRIP'
        : d.status === 'ON_TRIP'
          ? 'AVAILABLE'
          : d.status,
      // VMS spec §6.3 — driver licence expiry (spec puts licences on the driver record)
      licenseExpiryStatus: expiryStatus(d.licenseExpiry, now),
      ...(etaByDriver.has(d.id) ? { activeEta: etaByDriver.get(d.id) } : {}),
    }));
  }

  // ---------- document expiry alerts (VMS spec §6.3–6.4 — Phase A) ----------

  /** Currently non-VALID document expiries (vehicle registration/insurance +
   *  driver licences) for the dashboard card and the daily sweep. Sorted
   *  EXPIRED → DUE_TODAY → UPCOMING, then by date. */
  async expiryAlerts(now: Date = new Date()): Promise<ExpiryAlert[]> {
    const [vehicles, drivers] = await Promise.all([
      this.prisma.vehicle.findMany({ select: { id: true, vehicleNo: true, registrationExpiry: true, insuranceExpiry: true } }),
      this.prisma.driver.findMany({ select: { id: true, name: true, licenseExpiry: true } }),
    ]);
    const rows: ExpiryAlert[] = [];
    const push = (kind: ExpiryAlert['kind'], id: string, label: string, doc: ExpiryAlert['doc'], docLabel: string, expiry: Date | null) => {
      const status = expiryStatus(expiry, now);
      if (expiry && status && status !== 'VALID') {
        rows.push({ kind, id, label, doc, docLabel, expiry, status, daysLeft: daysUntilExpiry(expiry, now) });
      }
    };
    for (const v of vehicles) {
      push('VEHICLE', v.id, v.vehicleNo, 'registration', 'Vehicle registration', v.registrationExpiry);
      push('VEHICLE', v.id, v.vehicleNo, 'insurance', 'Motor insurance', v.insuranceExpiry);
    }
    for (const d of drivers) {
      push('DRIVER', d.id, d.name, 'license', 'Driver license', d.licenseExpiry);
    }
    const rank: Record<ExpiryAlert['status'], number> = { EXPIRED: 0, DUE_TODAY: 1, UPCOMING: 2 };
    return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.expiry.getTime() - b.expiry.getTime());
  }

  /** Daily document-expiry sweep — 08:30 business-local (spec §6.4 "daily
   *  scheduled job… configured timezone"). The backend container runs with
   *  TZ=Asia/Yangon (compose.yaml), so node-cron evaluates the schedule on
   *  Yangon wall-clock time — '30 8 * * *' = 08:30 Asia/Yangon. Alerts on
   *  EXPIRED / DUE_TODAY and on the 30/14/7/1-day thresholds exactly once each
   *  per recipient (Notification.dedupeKey), delivered in-app + Telegram via the
   *  shared notification service. Dashboard stays the source of truth if
   *  Telegram delivery fails (mirrors are best-effort by design). */
  @Cron('30 8 * * *')
  async dailyExpiryAlerts() {
    return this.runExpiryAlerts();
  }

  /** Sweep body — exported as a plain method so tests can drive `now`. */
  async runExpiryAlerts(now: Date = new Date()) {
    const alerts = (await this.expiryAlerts(now)).filter(
      (a) => a.status !== 'UPCOMING' || (EXPIRY_WARNING_DAYS as readonly number[]).includes(a.daysLeft),
    );
    if (alerts.length === 0) return { alerts: 0, recipients: 0, sent: 0 };
    // spec §6.4 recipients: fleet coordinators/managers — resolved server-side
    // from the permission, never from a client-supplied list
    const recipients = await this.permissions.usersWithPermissions([PERMISSIONS.FLEET_MANAGE]);
    if (recipients.length === 0) return { alerts: alerts.length, recipients: 0, sent: 0 };
    const keys = alerts.flatMap((a) => recipients.map((u) => `${alertKey(a)}:${u}`));
    const existing = new Set(
      (await this.prisma.notification.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } }))
        .map((n) => n.dedupeKey as string),
    );
    let sent = 0;
    for (const a of alerts) {
      const title = a.kind === 'VEHICLE'
        ? `📄 ${a.docLabel} expiring — ${a.label}`
        : `🪪 Driver license expiring — ${a.label}`;
      const when = a.status === 'EXPIRED' ? 'has EXPIRED'
        : a.status === 'DUE_TODAY' ? 'expires TODAY'
        : `expires in ${a.daysLeft} day(s)`;
      const body = `${a.docLabel} for ${a.label} ${when} — ${ymd(a.expiry)}. Start the renewal and update the record.`;
      for (const userId of recipients) {
        const dedupeKey = `${alertKey(a)}:${userId}`;
        if (existing.has(dedupeKey)) continue;
        try {
          await this.notifications.notify({ userId, type: 'VEHICLE_DOC_EXPIRY', title, body, link: '/fleet', dedupeKey });
          sent++;
        } catch (e) {
          // unique-index race (another instance sent it first) = already done
          this.logger.warn(`expiry alert skipped for ${userId}: ${(e as Error).message}`);
        }
      }
    }
    return { alerts: alerts.length, recipients: recipients.length, sent };
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
    name?: string; phone?: string | null; licenseNo?: string | null; licenseExpiry?: string | null;
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
    name?: string; phone?: string | null; licenseNo?: string | null; licenseExpiry?: string | null;
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
        // null clears the date, undefined leaves it unchanged
        licenseExpiry: data.licenseExpiry === null ? null : data.licenseExpiry ? new Date(data.licenseExpiry) : undefined,
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
   * Delete a driver.
   * Real trip history still BLOCKS deletion — suggest INACTIVE instead.
   * Vehicle links (vehicles.driverId) are cleared automatically by ON DELETE
   * SET NULL. Assignments whose request ended CANCELLED/REJECTED never became
   * a ride and are cleaned up in the same transaction (same rule as vehicles).
   */
  async deleteDriver(id: string, actor: Actor) {
    const driver = await this.prisma.driver.findUnique({
      where: { id },
      include: {
        _count: { select: { carRequests: true, carAssignments: true, absences: true } },
        carAssignments: { select: { id: true, request: { select: { status: true } } } },
      },
    });
    if (!driver) throw new NotFoundException('Driver not found');

    const live = driver.carAssignments.filter((a) => !['CANCELLED', 'REJECTED'].includes(a.request.status));
    const deadAssignmentIds = driver.carAssignments.filter((a) => ['CANCELLED', 'REJECTED'].includes(a.request.status)).map((a) => a.id);
    if (live.length > 0 || driver._count.carRequests > 0 || driver._count.absences > 0) {
      const used = live.length + driver._count.carRequests + driver._count.absences;
      throw new BadRequestException(
        `Cannot delete ${driver.name}: ${used} related trip record(s) exist. Set status to INACTIVE instead to keep history intact.`,
      );
    }

    await this.prisma.$transaction([
      ...(deadAssignmentIds.length
        ? [this.prisma.carAssignment.deleteMany({ where: { id: { in: deadAssignmentIds } } })]
        : []),
      this.prisma.driver.delete({ where: { id } }),
    ]);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_DELETED', module: 'FLEET', recordId: id,
      oldValue: { name: driver.name, droppedCancelledAssignments: deadAssignmentIds.length },
    });
    return { ok: true, droppedCancelledAssignments: deadAssignmentIds.length };
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

  /**
   * Derive the concrete leave window from the Company Time Table:
   *  FULL day        → Full Day start … Full Day end
   *  HALF / MORNING  → Morning start … Morning end
   *  HALF / EVENING  → Evening start … Evening end
   * The three ranges are independent (Settings → Company Time Table).
   * `date` is a calendar day (YYYY-MM-DD); the timetable times are local
   * office time (Asia/Yangon = server TZ, +06:30 without DST).
   */
  private async absenceWindow(date: string, dayType: AbsenceDayType, period: AbsencePeriod): Promise<{ startsAt: Date; endsAt: Date }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    const tt = await this.timetable.get();
    const at = (time: string) => new Date(`${date}T${time}:00+06:30`); // office local time
    if (dayType === 'FULL') return { startsAt: at(tt.fullStart), endsAt: at(tt.fullEnd) };
    if (period === 'MORNING') return { startsAt: at(tt.morningStart), endsAt: at(tt.morningEnd) };
    if (period === 'EVENING') return { startsAt: at(tt.eveningStart), endsAt: at(tt.eveningEnd) };
    throw new BadRequestException('Half-day leave needs a period: MORNING or EVENING');
  }

  /** Record a planned absence (leave) — window derived from the Company Time Table. */
  async createAbsence(
    data: { driverId: string; date: string; dayType: AbsenceDayType; period: AbsencePeriod; reason?: string },
    actor: { userId: string; username: string },
  ) {
    const driver = await this.prisma.driver.findUnique({ where: { id: data.driverId } });
    if (!driver) throw new NotFoundException('Driver not found');
    if (data.dayType === 'HALF' && data.period !== 'MORNING' && data.period !== 'EVENING') {
      throw new BadRequestException('Half-day leave needs a period: MORNING or EVENING');
    }
    if (data.dayType === 'FULL') data.period = 'FULL_DAY';
    const { startsAt, endsAt } = await this.absenceWindow(data.date, data.dayType, data.period);
    return this.writeAbsence({ driverId: data.driverId, startsAt, endsAt, dayType: data.dayType, period: data.period, reason: data.reason }, actor);
  }

  /** Update an absence (re-pick day/period or edit the reason). */
  async updateAbsence(
    id: string,
    data: { date: string; dayType: AbsenceDayType; period: AbsencePeriod; reason?: string },
    actor: { userId: string; username: string },
  ) {
    const absence = await this.prisma.driverAbsence.findUnique({ where: { id }, include: { driver: true } });
    if (!absence) throw new NotFoundException('Absence not found');
    if (absence.status !== 'ACTIVE') throw new BadRequestException('Absence already cancelled');
    if (data.dayType === 'HALF' && data.period !== 'MORNING' && data.period !== 'EVENING') {
      throw new BadRequestException('Half-day leave needs a period: MORNING or EVENING');
    }
    if (data.dayType === 'FULL') data.period = 'FULL_DAY';
    const { startsAt, endsAt } = await this.absenceWindow(data.date, data.dayType, data.period);
    const updated = await this.writeAbsence(
      { driverId: absence.driverId, startsAt, endsAt, dayType: data.dayType, period: data.period, reason: data.reason, existingId: id },
      actor,
    );
    return updated;
  }

  /** Shared create/update path: overlap + trip-clash checks, status flip, audit, notify. */
  private async writeAbsence(
    data: { driverId: string; startsAt: Date; endsAt: Date; dayType: AbsenceDayType; period: AbsencePeriod; reason?: string; existingId?: string },
    actor: { userId: string; username: string },
  ) {
    const { startsAt, endsAt, existingId } = data;
    const driver = await this.prisma.driver.findUnique({ where: { id: data.driverId } });
    if (!driver) throw new NotFoundException('Driver not found');
    if (!(endsAt > startsAt)) throw new BadRequestException('Absence end must be after start');
    // overlapping ACTIVE absence for the same driver is a mistake (double entry)
    const overlap = await this.prisma.driverAbsence.findFirst({
      where: {
        driverId: data.driverId,
        status: 'ACTIVE',
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(existingId ? { id: { not: existingId } } : {}),
      },
      select: { id: true, startsAt: true, endsAt: true },
    });
    if (overlap) throw new ConflictException(`Driver already has an absence ${overlap.startsAt.toISOString().slice(0, 10)} → ${overlap.endsAt.toISOString().slice(0, 10)}`);
    // future trips already assigned to this driver inside the window — warn loudly
    const trips = await this.prisma.carRequest.findMany({
      // base document status (single source of truth) — CarRequest.status is a mirror
      where: { driverId: data.driverId, startDate: { lt: endsAt }, endDate: { gt: startsAt }, request: { status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as never } } },
      select: { requestId: true, request: { select: { docNumber: true } } },
    });

    const absence = existingId
      ? await this.prisma.driverAbsence.update({
          where: { id: existingId },
          data: { startsAt, endsAt, dayType: data.dayType, period: data.period, reason: data.reason ?? null },
        })
      : await this.prisma.driverAbsence.create({
          data: {
            driverId: data.driverId,
            startsAt,
            endsAt,
            dayType: data.dayType,
            period: data.period,
            reason: data.reason,
            createdById: actor.userId,
          },
        });
    // already started (recording a same-day absence) → flip status now
    if (startsAt <= new Date() && driver.status === 'AVAILABLE') {
      await this.prisma.driver.update({ where: { id: driver.id }, data: { status: 'ON_LEAVE' } });
    }

    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: existingId ? 'DRIVER_ABSENCE_UPDATED' : 'DRIVER_ABSENCE_RECORDED',
      module: 'FLEET', recordId: absence.id,
      newValue: { driver: driver.name, startsAt, endsAt, dayType: data.dayType, period: data.period, reason: data.reason ?? null },
    });

    // tell whoever manages the fleet — especially important when future trips clash
    // (RBAC-native: fleet.manage holders, SYSTEM_ADMIN included via superuser)
    const adminIds = await this.permissions.usersWithPermissions(['fleet.manage']);
    if (adminIds.length) {
      const clash = trips.length ? ` ⚠️ ${trips.length} assigned trip(s) fall inside this window (${trips.map((t) => t.request.docNumber).join(', ')}) — re-assign them.` : '';
      const span = data.dayType === 'FULL' ? 'a full day' : `the ${data.period === 'MORNING' ? 'morning' : 'evening'} half`;
      await this.notifications.notifyMany(adminIds, {
        type: 'REMINDER' as never,
        title: `🗓 Driver absence — ${driver.name}`,
        body: `${driver.name} is on leave ${span} on ${startsAt.toISOString().slice(0, 10)}${data.reason ? ` (${data.reason})` : ''}.${clash}`,
        link: '/fleet',
      });
    }
    return { ...absence, clashes: trips.map((t) => t.request.docNumber) };
  }

  /** Delete an absence outright (admin cleanup) — restore status when the window is current. */
  async deleteAbsence(id: string, actor: { userId: string; username: string }) {
    const absence = await this.prisma.driverAbsence.findUnique({ where: { id }, include: { driver: true } });
    if (!absence) throw new NotFoundException('Absence not found');
    await this.prisma.$transaction([
      this.prisma.driverAbsence.delete({ where: { id } }),
      // restore status only when the window is current and the driver is not on a trip
      ...(absence.startsAt <= new Date() && absence.endsAt > new Date() && absence.driver.status === 'ON_LEAVE'
        ? [this.prisma.driver.update({ where: { id: absence.driverId }, data: { status: 'AVAILABLE' } })]
        : []),
    ]);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DRIVER_ABSENCE_DELETED', module: 'FLEET', recordId: id,
      oldValue: { driver: absence.driver.name, startsAt: absence.startsAt, endsAt: absence.endsAt, dayType: absence.dayType, period: absence.period },
      severity: 'WARNING',
    });
    return { ok: true };
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
   * Runs every 5 minutes so a Morning half-day ends at its configured End
   * Time, not up to an hour later.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async syncAbsenceStatuses() {
    const now = new Date();
    // windows that just started → ON_LEAVE
    const starting = await this.prisma.driverAbsence.findMany({
      where: { status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } },
      include: { driver: { select: { id: true, status: true } } },
    });
    let flipped = 0;
    for (const a of starting) {
      if (a.driver.status === 'AVAILABLE') {
        await this.prisma.driver.update({ where: { id: a.driverId }, data: { status: 'ON_LEAVE' } }).catch(() => undefined);
        flipped++;
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
        flipped++;
      }
    }
    // live push — Fleet absences tab + Car Panels refetch right away (best-effort)
    if (flipped > 0) {
      try {
        this.events.publish('driver.updated');
      } catch {
        /* SSE push is best-effort */
      }
    }
  }

  // ---------- vehicle unavailability windows (service / inspection / repair) ----------

  /** All vehicle unavailability windows — ACTIVE by default; ?all=true includes cancelled. */
  listVehicleUnavailabilities(all = false) {
    return this.prisma.vehicleUnavailability.findMany({
      where: all ? undefined : { status: 'ACTIVE' },
      orderBy: { startsAt: 'asc' },
      take: 200,
      include: { vehicle: { select: { id: true, vehicleNo: true, brandModel: true } } },
    });
  }

  /**
   * Block a vehicle for a known period (service, inspection, repair). Mirrors
   * createAbsence for drivers — Administration-only, overlapping windows for the
   * same vehicle are rejected as a double entry. Existing bookings inside the
   * window are NOT silently cancelled: the response lists them so the admin can
   * reshuffle (they stay visible in the conflict pre-warning and the assign
   * guards now block any re-assignment into this window).
   */
  async createVehicleUnavailability(
    data: { vehicleId: string; startsAt: string; endsAt: string; reason?: string },
    actor: Actor,
  ) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: data.vehicleId }, select: { id: true, vehicleNo: true } });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return this.writeVehicleUnavailability({ vehicleId: data.vehicleId, startsAt: data.startsAt, endsAt: data.endsAt, reason: data.reason }, actor);
  }

  /** Update a window (reschedule or edit the reason). */
  async updateVehicleUnavailability(
    id: string,
    data: { startsAt: string; endsAt: string; reason?: string },
    actor: Actor,
  ) {
    const row = await this.prisma.vehicleUnavailability.findUnique({ where: { id }, include: { vehicle: { select: { id: true, vehicleNo: true } } } });
    if (!row) throw new NotFoundException('Unavailability window not found');
    if (row.status !== 'ACTIVE') throw new BadRequestException('Unavailability window already cancelled');
    return this.writeVehicleUnavailability(
      { vehicleId: row.vehicleId, startsAt: data.startsAt, endsAt: data.endsAt, reason: data.reason, existingId: id },
      actor,
    );
  }

  private async writeVehicleUnavailability(
    data: { vehicleId: string; startsAt: string; endsAt: string; reason?: string; existingId?: string },
    actor: Actor,
  ) {
    const startsAt = new Date(data.startsAt);
    const endsAt = new Date(data.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('Invalid start/end time');
    }
    if (!(endsAt > startsAt)) throw new BadRequestException('End must be after start');
    // overlapping ACTIVE window for the same vehicle is a mistake (double entry)
    const overlap = await this.prisma.vehicleUnavailability.findFirst({
      where: {
        vehicleId: data.vehicleId,
        status: 'ACTIVE',
        ...(data.existingId ? { id: { not: data.existingId } } : {}),
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: { startsAt: true, endsAt: true },
    });
    if (overlap) {
      throw new ConflictException(
        `Vehicle already has an unavailability window ${overlap.startsAt.toISOString()} → ${overlap.endsAt.toISOString()}`,
      );
    }
    const row = data.existingId
      ? await this.prisma.vehicleUnavailability.update({
          where: { id: data.existingId },
          data: { startsAt, endsAt, reason: data.reason },
        })
      : await this.prisma.vehicleUnavailability.create({
          data: { vehicleId: data.vehicleId, startsAt, endsAt, reason: data.reason, createdById: actor.userId },
        });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: data.existingId ? 'VEHICLE_UNAVAILABILITY_UPDATED' : 'VEHICLE_UNAVAILABILITY_CREATED',
      module: 'FLEET', recordId: row.id,
      newValue: { vehicleId: data.vehicleId, startsAt: row.startsAt, endsAt: row.endsAt, reason: row.reason },
    });
    try {
      this.events.publish('vehicle.updated');
    } catch {
      /* SSE push is best-effort */
    }
    // transparency: surface the live bookings the window collides with so the
    // admin can reshuffle them — the windows themselves stay untouched
    const clashes = await this.prisma.carRequest.findMany({
      where: {
        vehicleId: data.vehicleId,
        request: { status: { in: ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'] as never[] } },
        startDate: { lt: endsAt },
        endDate: { gt: startsAt },
      },
      select: { request: { select: { docNumber: true } } },
      orderBy: { startDate: 'asc' },
      take: 10,
    });
    return { ...row, clashes: clashes.map((c) => c.request?.docNumber).filter(Boolean) };
  }

  /** Cancel a window — the vehicle becomes bookable for that period again. */
  async cancelVehicleUnavailability(id: string, actor: Actor) {
    const row = await this.prisma.vehicleUnavailability.findUnique({ where: { id }, include: { vehicle: { select: { vehicleNo: true } } } });
    if (!row) throw new NotFoundException('Unavailability window not found');
    if (row.status !== 'ACTIVE') throw new BadRequestException('Unavailability window already cancelled');
    const updated = await this.prisma.vehicleUnavailability.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_UNAVAILABILITY_CANCELLED', module: 'FLEET', recordId: id,
      oldValue: { vehicle: row.vehicle?.vehicleNo, startsAt: row.startsAt, endsAt: row.endsAt },
      newValue: { status: updated.status },
    });
    try {
      this.events.publish('vehicle.updated');
    } catch {
      /* SSE push is best-effort */
    }
    return updated;
  }

  /** Delete a window outright (admin cleanup). */
  async deleteVehicleUnavailability(id: string, actor: Actor) {
    const row = await this.prisma.vehicleUnavailability.findUnique({ where: { id }, include: { vehicle: { select: { vehicleNo: true } } } });
    if (!row) throw new NotFoundException('Unavailability window not found');
    await this.prisma.vehicleUnavailability.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_UNAVAILABILITY_DELETED', module: 'FLEET', recordId: id,
      oldValue: { vehicle: row.vehicle?.vehicleNo, startsAt: row.startsAt, endsAt: row.endsAt, reason: row.reason },
    });
    try {
      this.events.publish('vehicle.updated');
    } catch {
      /* SSE push is best-effort */
    }
    return { ok: true };
  }
}
