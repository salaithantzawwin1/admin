import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
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
import { FleetComplianceService, ComplianceViolation } from './compliance.service';
import { EXPIRY_WARNING_DAYS, ExpiryStatus, expiryStatus, daysUntilExpiry, ymd } from './expiry';

// Phase A helpers moved to ./expiry.ts in Phase B — re-exported so existing
// importers (tests, dashboard code) keep working unchanged.
export { EXPIRY_WARNING_DAYS, ExpiryStatus, expiryStatus, daysUntilExpiry } from './expiry';

/** Leave granularity against the Company Time Table. */
export type AbsenceDayType = 'FULL' | 'HALF';
export type AbsencePeriod = 'FULL_DAY' | 'MORNING' | 'EVENING';

// ---------- document expiry (VMS spec §6.3) — see ./expiry.ts (Phase B) ----------

/** §6.3 per-type reminder thresholds — whole days 1–365, deduped, descending. */
function normalizeWarningDays(days?: number[]): number[] {
  if (!days) return [];
  if (days.some((n) => !Number.isInteger(n) || n < 1 || n > 365)) {
    throw new BadRequestException('Warning days must be whole numbers between 1 and 365');
  }
  return [...new Set(days)].sort((a, b) => b - a);
}

/** Optional date body param: undefined = leave unchanged, ''/null = clear,
 *  anything unparseable = 400 (never silently stored). */
function parseOptionalDate(value: string | null | undefined, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be a valid date`);
  return d;
}

export interface ExpiryAlert {
  kind: 'VEHICLE' | 'DRIVER' | 'DOCUMENT';
  id: string;
  /** vehicleNo, driver name, or "vehicleNo — doc type" */
  label: string;
  doc: string; // 'registration' | 'insurance' | 'license' | document-type code
  docLabel: string;
  expiry: Date;
  status: 'EXPIRED' | 'DUE_TODAY' | 'UPCOMING';
  daysLeft: number;
  /** per-type reminder thresholds (§6.2); undefined = global 30/14/7/1 */
  thresholds?: readonly number[];
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
    /** Phase B — optional so legacy test constructions (7 args) keep working;
     *  the app provides it via FleetComplianceModule. */
    @Optional() private compliance?: FleetComplianceService,
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

  // ---------- document types (VMS spec §6.1 — Phase B) ----------

  /** Active types drive the register pickers; managers pass ?all=true. */
  listDocumentTypes(all = false) {
    return this.prisma.vehicleDocumentType.findMany({
      where: all ? undefined : { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createDocumentType(
    dto: { code: string; name: string; vehicleType?: string | null; mandatoryForDispatch?: boolean; allowNoExpiry?: boolean; warningDays?: number[]; sortOrder?: number },
    actor: Actor,
  ) {
    const code = dto.code.trim().toUpperCase().replace(/\s+/g, '_');
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(code)) {
      throw new BadRequestException('Code: letters/numbers/underscore (e.g. ROAD_TAX) — stored uppercase like the existing list');
    }
    const name = dto.name?.trim() ?? '';
    if (name.length < 2 || name.length > 120) throw new BadRequestException('Name must be 2–120 characters');
    const exists = await this.prisma.vehicleDocumentType.findUnique({ where: { code } });
    if (exists) throw new ConflictException(`Document type "${code}" already exists`);
    const type = await this.prisma.vehicleDocumentType.create({
      data: {
        code, name,
        vehicleType: (dto.vehicleType || null) as never,
        mandatoryForDispatch: dto.mandatoryForDispatch ?? false,
        allowNoExpiry: dto.allowNoExpiry ?? false,
        warningDays: normalizeWarningDays(dto.warningDays),
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DOCUMENT_TYPE_CREATED', module: 'FLEET', recordId: type.id,
      newValue: { code: type.code, name: type.name, vehicleType: type.vehicleType, mandatoryForDispatch: type.mandatoryForDispatch },
    });
    return type;
  }

  async updateDocumentType(
    id: string,
    dto: { name?: string; vehicleType?: string | null; mandatoryForDispatch?: boolean; allowNoExpiry?: boolean; warningDays?: number[]; active?: boolean; sortOrder?: number },
    actor: Actor,
  ) {
    const type = await this.prisma.vehicleDocumentType.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('Document type not found');
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name.length < 2 || name.length > 120) throw new BadRequestException('Name must be 2–120 characters');
      data.name = name;
    }
    if (dto.vehicleType !== undefined) data.vehicleType = (dto.vehicleType || null) as never;
    if (dto.mandatoryForDispatch !== undefined) data.mandatoryForDispatch = dto.mandatoryForDispatch;
    if (dto.allowNoExpiry !== undefined) data.allowNoExpiry = dto.allowNoExpiry;
    if (dto.warningDays !== undefined) data.warningDays = normalizeWarningDays(dto.warningDays);
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    const updated = await this.prisma.vehicleDocumentType.update({ where: { id }, data });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DOCUMENT_TYPE_UPDATED', module: 'FLEET', recordId: id,
      oldValue: { name: type.name, mandatoryForDispatch: type.mandatoryForDispatch, allowNoExpiry: type.allowNoExpiry, active: type.active, vehicleType: type.vehicleType, warningDays: type.warningDays },
      newValue: { name: updated.name, mandatoryForDispatch: updated.mandatoryForDispatch, allowNoExpiry: updated.allowNoExpiry, active: updated.active, vehicleType: updated.vehicleType, warningDays: updated.warningDays },
    });
    return updated;
  }

  /** Delete only when no document record uses the type — otherwise deactivate
   *  so the register/history stays intact (same rule as vehicle types). */
  async deleteDocumentType(id: string, actor: Actor) {
    const type = await this.prisma.vehicleDocumentType.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('Document type not found');
    const used = await this.prisma.vehicleDocument.count({ where: { documentTypeId: id } });
    if (used > 0) {
      throw new ConflictException(`Cannot delete "${type.name}": ${used} document record(s) use it — deactivate it instead`);
    }
    await this.prisma.vehicleDocumentType.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'DOCUMENT_TYPE_DELETED', module: 'FLEET', recordId: id,
      oldValue: { code: type.code, name: type.name },
    });
    return { ok: true };
  }

  // ---------- vehicle document register (VMS spec §6.2 — Phase B) ----------

  /** Full register for one vehicle: current rows AND superseded history
   *  (spec §6.2: versions are kept, a renewal never overwrites the old date). */
  async listVehicleDocuments(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true, vehicleNo: true } });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    const docs = await this.prisma.vehicleDocument.findMany({
      where: { vehicleId },
      include: {
        documentType: { select: { id: true, code: true, name: true, mandatoryForDispatch: true, allowNoExpiry: true } },
        attachment: { select: { id: true, filename: true, mimeType: true, size: true } },
      },
      orderBy: [{ documentTypeId: 'asc' }, { createdAt: 'desc' }],
    });
    return docs.map((d) => {
      const current = d.supersededById === null;
      return {
        ...d,
        current,
        // status only for current rows — superseded history shows renewalStatus
        status: current ? expiryStatus(d.expiryDate) : null,
        daysLeft: current && d.expiryDate ? daysUntilExpiry(d.expiryDate) : null,
      };
    });
  }

  async createVehicleDocument(
    vehicleId: string,
    dto: { documentTypeId: string; documentNo?: string; issuingAuthority?: string; issueDate?: string; expiryDate?: string | null; renewalStatus?: string; notes?: string; attachmentId?: string },
    actor: Actor,
  ) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true, vehicleNo: true } });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    const type = await this.prisma.vehicleDocumentType.findUnique({ where: { id: dto.documentTypeId } });
    if (!type) throw new NotFoundException('Document type not found');
    const expiry = parseOptionalDate(dto.expiryDate, 'expiryDate');
    if (!expiry && !type.allowNoExpiry) {
      throw new BadRequestException(`"${type.name}" requires an expiry date (enable "no expiry" on the type if this document never expires)`);
    }
    const issue = parseOptionalDate(dto.issueDate, 'issueDate');
    if (issue && expiry && issue > expiry) throw new BadRequestException('Issue date cannot be after the expiry date');
    // one CURRENT record per vehicle+type — renewals create versions, not duplicates
    const existing = await this.prisma.vehicleDocument.findFirst({
      where: { vehicleId, documentTypeId: type.id, supersededById: null },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`"${type.name}" already has a record for ${vehicle.vehicleNo} — renew it instead of adding a second one`);
    }
    await this.assertAttachment(dto.attachmentId);
    const doc = await this.prisma.vehicleDocument.create({
      data: {
        vehicleId,
        documentTypeId: type.id,
        documentNo: dto.documentNo?.trim() || null,
        issuingAuthority: dto.issuingAuthority?.trim() || null,
        issueDate: issue,
        expiryDate: expiry,
        renewalStatus: (dto.renewalStatus as never) || 'NOT_STARTED',
        notes: dto.notes?.trim() || null,
        attachmentId: dto.attachmentId || null,
      },
    });
    await this.mirrorLegacyExpiry(vehicleId, type.code, expiry ?? null);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_DOCUMENT_CREATED', module: 'FLEET', recordId: doc.id,
      newValue: { vehicleNo: vehicle.vehicleNo, document: type.name, expiryDate: expiry, documentNo: doc.documentNo },
    });
    return doc;
  }

  /** Edit the CURRENT record in place (history rows are immutable — renewals
   *  preserve the old date, spec §6.2). */
  async updateVehicleDocument(
    id: string,
    dto: { documentNo?: string | null; issuingAuthority?: string | null; issueDate?: string | null; expiryDate?: string | null; renewalStatus?: string; notes?: string | null; attachmentId?: string | null },
    actor: Actor,
  ) {
    const doc = await this.prisma.vehicleDocument.findUnique({
      where: { id },
      include: { documentType: true, vehicle: { select: { vehicleNo: true } } },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.supersededById) {
      throw new ConflictException('This record was superseded by a renewal — history is preserved and cannot be edited');
    }
    const expiry = dto.expiryDate !== undefined ? parseOptionalDate(dto.expiryDate, 'expiryDate') : undefined;
    if (expiry === null && !doc.documentType.allowNoExpiry) {
      throw new BadRequestException(`"${doc.documentType.name}" requires an expiry date (enable "no expiry" on the type first)`);
    }
    const issue = dto.issueDate !== undefined ? parseOptionalDate(dto.issueDate, 'issueDate') : undefined;
    const effectiveExpiry = expiry === undefined ? doc.expiryDate : expiry;
    const effectiveIssue = issue === undefined ? doc.issueDate : issue;
    if (effectiveIssue && effectiveExpiry && effectiveIssue > effectiveExpiry) {
      throw new BadRequestException('Issue date cannot be after the expiry date');
    }
    const data: Record<string, unknown> = {};
    if (dto.documentNo !== undefined) data.documentNo = dto.documentNo?.trim() || null;
    if (dto.issuingAuthority !== undefined) data.issuingAuthority = dto.issuingAuthority?.trim() || null;
    if (issue !== undefined) data.issueDate = issue;
    if (expiry !== undefined) data.expiryDate = expiry;
    if (dto.renewalStatus !== undefined) {
      if (dto.renewalStatus === 'RENEWED') throw new BadRequestException('renewalStatus=RENEWED is written by the renew action, not by hand');
      data.renewalStatus = dto.renewalStatus;
    }
    if (dto.notes !== undefined) data.notes = dto.notes?.trim() || null;
    if (dto.attachmentId !== undefined) data.attachmentId = dto.attachmentId || null;
    await this.assertAttachment(dto.attachmentId);
    const updated = await this.prisma.vehicleDocument.update({ where: { id }, data });
    if (expiry !== undefined) await this.mirrorLegacyExpiry(doc.vehicleId, doc.documentType.code, expiry);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_DOCUMENT_UPDATED', module: 'FLEET', recordId: id,
      oldValue: { expiryDate: doc.expiryDate, renewalStatus: doc.renewalStatus, documentNo: doc.documentNo },
      newValue: { expiryDate: updated.expiryDate, renewalStatus: updated.renewalStatus, documentNo: updated.documentNo },
    });
    return updated;
  }

  /** Renewal (spec §6.2): a NEW record points at the old one, the old row gets
   *  supersededById + renewalStatus=RENEWED — the previous expiry is never
   *  overwritten (§6.4: renewal closes the old reminders and schedules the new). */
  async renewVehicleDocument(
    id: string,
    dto: { documentNo?: string; issuingAuthority?: string; issueDate?: string; expiryDate?: string | null; notes?: string; attachmentId?: string },
    actor: Actor,
  ) {
    const old = await this.prisma.vehicleDocument.findUnique({
      where: { id },
      include: { documentType: true, vehicle: { select: { vehicleNo: true } } },
    });
    if (!old) throw new NotFoundException('Document not found');
    if (old.supersededById) {
      throw new ConflictException('This record was already renewed — open the current record instead');
    }
    const expiry = parseOptionalDate(dto.expiryDate, 'expiryDate');
    if (!expiry && !old.documentType.allowNoExpiry) {
      throw new BadRequestException(`The renewed "${old.documentType.name}" record requires an expiry date`);
    }
    const issue = parseOptionalDate(dto.issueDate, 'issueDate');
    if (issue && expiry && issue > expiry) throw new BadRequestException('Issue date cannot be after the expiry date');
    await this.assertAttachment(dto.attachmentId);

    const created = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.vehicleDocument.create({
        data: {
          vehicleId: old.vehicleId,
          documentTypeId: old.documentTypeId,
          documentNo: dto.documentNo?.trim() || null,
          issuingAuthority: dto.issuingAuthority?.trim() || null,
          issueDate: issue,
          expiryDate: expiry,
          notes: dto.notes?.trim() || null,
          attachmentId: dto.attachmentId || null,
          previousId: old.id,
        },
      });
      await tx.vehicleDocument.update({
        where: { id: old.id },
        data: { supersededById: doc.id, renewalStatus: 'RENEWED' },
      });
      return doc;
    });
    await this.mirrorLegacyExpiry(old.vehicleId, old.documentType.code, expiry ?? null);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_DOCUMENT_RENEWED', module: 'FLEET', recordId: created.id,
      oldValue: { expiryDate: old.expiryDate, documentNo: old.documentNo },
      newValue: { vehicleNo: old.vehicle.vehicleNo, document: old.documentType.name, expiryDate: expiry, documentNo: created.documentNo, previousId: old.id },
    });
    return created;
  }

  /** Delete a CURRENT record only (superseded history is never removed). */
  async deleteVehicleDocument(id: string, actor: Actor) {
    const doc = await this.prisma.vehicleDocument.findUnique({
      where: { id },
      include: { documentType: true, vehicle: { select: { vehicleNo: true } } },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.supersededById) {
      throw new ConflictException('Cannot delete a superseded record — renewals are kept as history (spec §6.2)');
    }
    await this.prisma.vehicleDocument.delete({ where: { id } });
    // the legacy column mirrors whatever current record remains (usually none → null)
    const remaining = await this.prisma.vehicleDocument.findFirst({
      where: { vehicleId: doc.vehicleId, documentTypeId: doc.documentTypeId, supersededById: null },
      select: { expiryDate: true },
      orderBy: { createdAt: 'desc' },
    });
    await this.mirrorLegacyExpiry(doc.vehicleId, doc.documentType.code, remaining?.expiryDate ?? null);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'VEHICLE_DOCUMENT_DELETED', module: 'FLEET', recordId: id,
      oldValue: { vehicleNo: doc.vehicle.vehicleNo, document: doc.documentType.name, expiryDate: doc.expiryDate },
    });
    return { ok: true };
  }

  /** §6.5 compliance for one vehicle — the same rules the assign/dispatch
   *  block uses, exposed for the vehicle documents panel. */
  async vehicleCompliance(vehicleId: string) {
    if (!this.compliance) return { violations: [] as ComplianceViolation[] };
    const violations = (await this.compliance.violationsForVehicle(vehicleId)) ?? [];
    return { violations };
  }

  /** Linking a file is by id (upload happens through POST /attachments/upload);
   *  validate the target exists so a typo cannot store a dangling reference. */
  private async assertAttachment(attachmentId?: string | null) {
    if (!attachmentId) return;
    const a = await this.prisma.attachment.findUnique({ where: { id: attachmentId }, select: { id: true } });
    if (!a) throw new BadRequestException('attachmentId does not exist — upload the file first');
  }

  /** The two legacy Phase A columns stay in sync with the register so the fleet
   *  table's Expiry column and the Phase A list statuses keep working. */
  private async mirrorLegacyExpiry(vehicleId: string, code: string, expiry: Date | null) {
    if (code === 'REGISTRATION') {
      await this.prisma.vehicle.update({ where: { id: vehicleId }, data: { registrationExpiry: expiry } });
    } else if (code === 'INSURANCE') {
      await this.prisma.vehicle.update({ where: { id: vehicleId }, data: { insuranceExpiry: expiry } });
    }
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
  /** `now` is injectable for tests (list statuses are stamped against it;
   *  production callers omit it for the real clock). */
  async listVehicles(status?: VehicleStatus, now: Date = new Date()) {
    const rows = await this.prisma.vehicle.findMany({
      where: status ? { status } : undefined,
      orderBy: { vehicleNo: 'asc' },
      include: { driver: true },
    });
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
    // §6.5 dispatch-compliance chip (only when the compliance service is wired)
    const blocked = this.compliance ? await this.compliance.blockedMap(rows, now) : null;
    // a trip the driver STARTED that runs past its window must keep the car
    // IN_USE until the odometer close-out — otherwise a running-late ride
    // flashes AVAILABLE and someone else books the car mid-trip
    const startedTrips = await this.prisma.carAssignment.findMany({
      where: { releasedAt: null, trip: { status: 'STARTED' } },
      select: { vehicleId: true },
    });
    const started = new Set(startedTrips.map((t) => t.vehicleId));
    return rows.map((v) => {
      const violations = blocked?.get(v.id);
      return {
        ...v,
        status: onRoad.has(v.id) || started.has(v.id)
          ? 'IN_USE'
          : v.status === 'IN_USE'
            ? 'AVAILABLE'
            : v.status,
        // VMS spec §6.3 — shared server-side expiry status (lists, dashboard, alerts)
        registrationExpiryStatus: expiryStatus(v.registrationExpiry, now),
        insuranceExpiryStatus: expiryStatus(v.insuranceExpiry, now),
        // VMS spec §6.5 — mandatory-document compliance (assign/dispatch block)
        dispatchBlocked: !!violations?.length,
        dispatchBlockReason: violations?.length ? violations.map((x) => x.detail).join(' · ') : null,
      };
    });
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

  // ---------- document expiry alerts (VMS spec §6.3–6.4) ----------

  /** Currently non-VALID document expiries for the dashboard card and the
   *  daily sweep: document-register records (Phase B) + the legacy vehicle
   *  registration/insurance columns + driver licences. A legacy column is
   *  suppressed as soon as a current register record covers the same code —
   *  the register rows backfilled by migration 53 carry the same dates, and
   *  the two would otherwise alert twice (different dedup keys). Sorted
   *  EXPIRED → DUE_TODAY → UPCOMING, then by date. */
  async expiryAlerts(now: Date = new Date()): Promise<ExpiryAlert[]> {
    const [vehicles, drivers, docRows] = await Promise.all([
      this.prisma.vehicle.findMany({ select: { id: true, vehicleNo: true, registrationExpiry: true, insuranceExpiry: true } }),
      this.prisma.driver.findMany({ select: { id: true, name: true, licenseExpiry: true } }),
      // current (non-superseded) register records with a date — §6.2/§6.4:
      // a renewal supersedes the old row, which closes its reminders
      this.prisma.vehicleDocument.findMany({
        where: { supersededById: null, expiryDate: { not: null } },
        select: {
          id: true, vehicleId: true, expiryDate: true,
          documentType: { select: { code: true, name: true, warningDays: true } },
          vehicle: { select: { vehicleNo: true } },
        },
      }),
    ]);
    const rows: ExpiryAlert[] = [];
    const push = (kind: ExpiryAlert['kind'], id: string, label: string, doc: string, docLabel: string, expiry: Date | null, thresholds?: readonly number[]) => {
      const status = expiryStatus(expiry, now);
      if (expiry && status && status !== 'VALID') {
        rows.push({ kind, id, label, doc, docLabel, expiry, status, daysLeft: daysUntilExpiry(expiry, now), ...(thresholds?.length ? { thresholds } : {}) });
      }
    };
    // Phase B register records first — they mark their vehicle+code as "covered"
    const registerBacked = new Set<string>();
    for (const r of docRows) {
      registerBacked.add(`${r.vehicleId}:${r.documentType.code}`);
      push('DOCUMENT', r.id, r.vehicle.vehicleNo, r.documentType.code, r.documentType.name, r.expiryDate, r.documentType.warningDays);
    }
    for (const v of vehicles) {
      // legacy Phase A columns — only while no register record covers them
      if (!registerBacked.has(`${v.id}:REGISTRATION`)) push('VEHICLE', v.id, v.vehicleNo, 'registration', 'Vehicle registration', v.registrationExpiry);
      if (!registerBacked.has(`${v.id}:INSURANCE`)) push('VEHICLE', v.id, v.vehicleNo, 'insurance', 'Motor insurance', v.insuranceExpiry);
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
      // register records may carry per-type thresholds (§6.2/§6.3); the Phase A
      // columns and licences fall back to the global 30/14/7/1 defaults
      (a) => a.status !== 'UPCOMING' || (a.thresholds ?? (EXPIRY_WARNING_DAYS as readonly number[])).includes(a.daysLeft),
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
      const title = a.kind === 'DRIVER'
        ? `🪪 Driver license expiring — ${a.label}`
        : `📄 ${a.docLabel} expiring — ${a.label}`;
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
