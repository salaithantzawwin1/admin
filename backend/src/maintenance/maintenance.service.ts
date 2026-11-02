import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { Actor } from '../org/org.service';

/** §14 — what kind of work the record describes. */
export const MAINTENANCE_TYPES = [
  'PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'WARRANTY_SERVICE', 'EMERGENCY',
] as const;

/** §13 — where the job stands. COMPLETED is the default: recording a past
 *  service after the fact is the common case for this office. */
export const MAINTENANCE_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;

/** Anything due inside this window counts as "due soon" on the dashboard. */
const DUE_SOON_DAYS = 30;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 2026-11-02 + 6 months → 2027-05-02 (day is clamped, e.g. 31 Jan + 1 = 28 Feb). */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function parseDate(value: string | null | undefined, label: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${label}`);
  return d;
}

@Injectable()
export class MaintenanceService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private numbering: NumberingService,
  ) {}

  // ---------- service records (§13/§14) ----------

  /** Records list, newest first; `assetId` scopes it to one unit's history. */
  async list(filters: { assetId?: string; type?: string; from?: string; to?: string }) {
    const where: any = {};
    if (filters.assetId) where.assetId = filters.assetId;
    if (filters.type) {
      if (!(MAINTENANCE_TYPES as readonly string[]).includes(filters.type)) {
        throw new BadRequestException('Unknown maintenance type');
      }
      where.type = filters.type;
    }
    const gte = filters.from ? parseDate(filters.from, 'from date') : undefined;
    const lt = filters.to ? parseDate(filters.to, 'to date') : undefined;
    if (gte || lt) {
      where.date = {
        ...(gte ? { gte } : {}),
        ...(lt ? { lt: new Date((lt as Date).getTime() + 24 * 3600 * 1000) } : {}),
      };
    }
    return this.prisma.maintenanceRecord.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      include: {
        asset: { select: { id: true, assetCode: true, name: true } },
        vendor: { select: { id: true, name: true } },
        createdBy: { select: { username: true } },
      },
    });
  }

  async detail(id: string) {
    const row = await this.prisma.maintenanceRecord.findUnique({
      where: { id },
      include: {
        asset: { select: { id: true, assetCode: true, name: true } },
        vendor: { select: { id: true, name: true } },
        createdBy: { select: { username: true } },
      },
    });
    if (!row) throw new NotFoundException('Maintenance record not found');
    return { ...row, costTotal: this.totalOf(row) };
  }

  /** Record a service job. The parts+labor+other total is written into the
   *  asset cost ledger in the same call, so the unit's spend is never a
   *  second, hand-kept number. */
  async create(data: {
    assetId: string; type?: string; status?: string; date?: string;
    problem?: string; workDone?: string; vendorId?: string; technician?: string;
    costParts?: number; costLabor?: number; costOther?: number;
    downtimeHours?: number; warrantyEndDate?: string; nextDueDate?: string; note?: string;
  }, actor: Actor) {
    const asset = await this.prisma.asset.findUnique({ where: { id: data.assetId } });
    if (!asset) throw new BadRequestException('Unknown asset');
    const type = this.checkType(data.type);
    const status = this.checkStatus(data.status);
    const date = parseDate(data.date, 'maintenance date') ?? new Date();
    const costs = this.checkCosts(data);
    if (data.vendorId) await this.assertVendor(data.vendorId);

    // MRC-2611-0001 — the stamp follows the service date, not today, so a
    // back-filled record still reads in the month the work happened.
    const code = await this.numbering.next('MRC', date as Date, 2);

    const row = await this.prisma.maintenanceRecord.create({
      data: {
        code,
        assetId: data.assetId,
        type,
        status,
        date: date as Date,
        problem: data.problem?.trim() || undefined,
        workDone: data.workDone?.trim() || undefined,
        vendorId: data.vendorId || undefined,
        technician: data.technician?.trim() || undefined,
        costParts: costs.parts,
        costLabor: costs.labor,
        costOther: costs.other,
        downtimeHours: data.downtimeHours ?? undefined,
        warrantyEndDate: parseDate(data.warrantyEndDate, 'warranty end date') ?? undefined,
        nextDueDate: parseDate(data.nextDueDate, 'next due date') ?? undefined,
        note: data.note?.trim() || undefined,
        createdById: actor.userId,
      },
    });
    await this.syncCost(row);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MAINTENANCE_RECORD_CREATED', module: 'MAINTENANCE', recordId: row.id,
      newValue: { code: row.code, assetCode: asset.assetCode, type, cost: costs.total, date: row.date },
    });
    return this.detail(row.id);
  }

  async update(id: string, data: {
    type?: string; status?: string; date?: string;
    problem?: string | null; workDone?: string | null; vendorId?: string | null; technician?: string | null;
    costParts?: number; costLabor?: number; costOther?: number;
    downtimeHours?: number | null; warrantyEndDate?: string | null; nextDueDate?: string | null; note?: string | null;
  }, actor: Actor) {
    const prev = await this.prisma.maintenanceRecord.findUnique({ where: { id }, include: { asset: true } });
    if (!prev) throw new NotFoundException('Maintenance record not found');
    const costs = this.checkCosts({
      costParts: data.costParts ?? Number(prev.costParts),
      costLabor: data.costLabor ?? Number(prev.costLabor),
      costOther: data.costOther ?? Number(prev.costOther),
    });
    if (data.vendorId) await this.assertVendor(data.vendorId);

    const row = await this.prisma.maintenanceRecord.update({
      where: { id },
      data: {
        type: data.type !== undefined ? this.checkType(data.type) : undefined,
        status: data.status !== undefined ? this.checkStatus(data.status) : undefined,
        date: parseDate(data.date, 'maintenance date') ?? undefined,
        problem: data.problem !== undefined ? (data.problem?.trim() || null) : undefined,
        workDone: data.workDone !== undefined ? (data.workDone?.trim() || null) : undefined,
        vendorId: data.vendorId !== undefined ? (data.vendorId || null) : undefined,
        technician: data.technician !== undefined ? (data.technician?.trim() || null) : undefined,
        costParts: costs.parts,
        costLabor: costs.labor,
        costOther: costs.other,
        downtimeHours: data.downtimeHours !== undefined ? data.downtimeHours : undefined,
        warrantyEndDate: parseDate(data.warrantyEndDate, 'warranty end date') ?? undefined,
        nextDueDate: parseDate(data.nextDueDate, 'next due date') ?? undefined,
        note: data.note !== undefined ? (data.note?.trim() || null) : undefined,
      },
    });
    await this.syncCost(row);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MAINTENANCE_RECORD_UPDATED', module: 'MAINTENANCE', recordId: id,
      oldValue: { type: prev.type, status: prev.status, costParts: Number(prev.costParts), costLabor: Number(prev.costLabor), costOther: Number(prev.costOther) },
      newValue: { type: row.type, status: row.status, costParts: Number(row.costParts), costLabor: Number(row.costLabor), costOther: Number(row.costOther) },
    });
    return this.detail(id);
  }

  /** Delete a record and the ledger row it wrote — the history of a unit must
   *  not keep money for a job that never happened. */
  async remove(id: string, actor: Actor) {
    const prev = await this.prisma.maintenanceRecord.findUnique({ where: { id }, include: { asset: true } });
    if (!prev) throw new NotFoundException('Maintenance record not found');
    await this.prisma.assetCost.deleteMany({ where: { sourceType: 'MAINTENANCE', sourceId: id } });
    await this.prisma.maintenanceRecord.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MAINTENANCE_RECORD_DELETED', module: 'MAINTENANCE', recordId: id,
      oldValue: { code: prev.code, assetCode: prev.asset?.assetCode, type: prev.type, date: prev.date },
      severity: 'WARNING',
    });
    return { success: true };
  }

  // ---------- preventive schedules (§15) ----------

  /** Schedules with the due state the dashboard sorts on. */
  async listSchedules(params: { assetId?: string; dueOnly?: boolean } = {}) {
    const where: any = { active: true };
    if (params.assetId) where.assetId = params.assetId;
    const rows = await this.prisma.maintenanceSchedule.findMany({
      where,
      orderBy: { nextDueAt: 'asc' },
      include: { asset: { select: { id: true, assetCode: true, name: true } } },
    });
    const now = Date.now();
    const soon = now + DUE_SOON_DAYS * 24 * 3600 * 1000;
    const decorated = rows.map((r) => {
      const due = new Date(r.nextDueAt).getTime();
      return {
        ...r,
        dueState: due < now ? 'OVERDUE' : due <= soon ? 'DUE_SOON' : 'OK',
        daysLeft: Math.ceil((due - now) / (24 * 3600 * 1000)),
      };
    });
    return params.dueOnly ? decorated.filter((r) => r.dueState !== 'OK') : decorated;
  }

  async createSchedule(data: {
    assetId: string; title: string; intervalMonths: number;
    lastDoneAt?: string; nextDueAt?: string; note?: string;
  }, actor: Actor) {
    const asset = await this.prisma.asset.findUnique({ where: { id: data.assetId } });
    if (!asset) throw new BadRequestException('Unknown asset');
    const title = (data.title ?? '').trim();
    if (!title) throw new BadRequestException('A schedule needs a title (e.g. "Aircon gas service")');
    const interval = Number(data.intervalMonths);
    if (!Number.isInteger(interval) || interval < 1 || interval > 120) {
      throw new BadRequestException('Interval must be a whole number of months (1–120)');
    }
    const lastDoneAt = parseDate(data.lastDoneAt, 'last done date') ?? null;
    // no explicit next date → derive it from the last service + interval
    const nextDueAt =
      parseDate(data.nextDueAt, 'next due date') ??
      addMonths(lastDoneAt ?? new Date(), interval);

    const row = await this.prisma.maintenanceSchedule.create({
      data: {
        assetId: data.assetId, title, intervalMonths: interval,
        lastDoneAt: lastDoneAt ?? undefined,
        nextDueAt: nextDueAt as Date,
        note: data.note?.trim() || undefined,
        createdById: actor.userId,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MAINTENANCE_SCHEDULE_CREATED', module: 'MAINTENANCE', recordId: row.id,
      newValue: { assetCode: asset.assetCode, title, intervalMonths: interval, nextDueAt },
    });
    return row;
  }

  async updateSchedule(id: string, data: {
    title?: string; intervalMonths?: number; lastDoneAt?: string | null;
    nextDueAt?: string; active?: boolean; note?: string | null;
  }, actor: Actor) {
    const prev = await this.prisma.maintenanceSchedule.findUnique({ where: { id } });
    if (!prev) throw new NotFoundException('Schedule not found');
    const interval = data.intervalMonths !== undefined ? Number(data.intervalMonths) : prev.intervalMonths;
    if (!Number.isInteger(interval) || interval < 1 || interval > 120) {
      throw new BadRequestException('Interval must be a whole number of months (1–120)');
    }
    const lastDone = parseDate(data.lastDoneAt, 'last done date');
    const nextDueAt =
      parseDate(data.nextDueAt, 'next due date') ??
      (lastDone ? addMonths(lastDone, interval) : undefined);

    const row = await this.prisma.maintenanceSchedule.update({
      where: { id },
      data: {
        title: data.title?.trim() || undefined,
        intervalMonths: interval,
        lastDoneAt: lastDone !== undefined ? lastDone : undefined,
        nextDueAt: nextDueAt as Date | undefined,
        active: data.active,
        note: data.note !== undefined ? (data.note?.trim() || null) : undefined,
      },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MAINTENANCE_SCHEDULE_UPDATED', module: 'MAINTENANCE', recordId: id,
      oldValue: { nextDueAt: prev.nextDueAt, intervalMonths: prev.intervalMonths },
      newValue: { nextDueAt: row.nextDueAt, intervalMonths: row.intervalMonths },
    });
    return row;
  }

  /** "Service done" — roll the schedule forward by one interval. */
  async completeSchedule(id: string, data: { doneAt?: string } = {}, actor: Actor) {
    const prev = await this.prisma.maintenanceSchedule.findUnique({ where: { id } });
    if (!prev) throw new NotFoundException('Schedule not found');
    const doneAt = parseDate(data.doneAt, 'done date') ?? new Date();
    const nextDueAt = addMonths(doneAt as Date, prev.intervalMonths);
    const row = await this.prisma.maintenanceSchedule.update({
      where: { id },
      data: { lastDoneAt: doneAt as Date, nextDueAt },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MAINTENANCE_SCHEDULE_COMPLETED', module: 'MAINTENANCE', recordId: id,
      oldValue: { nextDueAt: prev.nextDueAt }, newValue: { doneAt, nextDueAt },
    });
    return row;
  }

  async removeSchedule(id: string, actor: Actor) {
    const prev = await this.prisma.maintenanceSchedule.findUnique({ where: { id } });
    if (!prev) throw new NotFoundException('Schedule not found');
    await this.prisma.maintenanceSchedule.delete({ where: { id } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'MAINTENANCE_SCHEDULE_DELETED', module: 'MAINTENANCE', recordId: id,
      oldValue: { title: prev.title, nextDueAt: prev.nextDueAt }, severity: 'WARNING',
    });
    return { success: true };
  }

  /** Dashboard tile: how many schedules are overdue / due within the window. */
  async summary() {
    const rows = await this.listSchedules({});
    return {
      overdue: rows.filter((r) => r.dueState === 'OVERDUE').length,
      dueSoon: rows.filter((r) => r.dueState === 'DUE_SOON').length,
      active: rows.length,
    };
  }

  // ---------- helpers ----------

  private totalOf(row: { costParts: unknown; costLabor: unknown; costOther: unknown }): number {
    return round2(Number(row.costParts) + Number(row.costLabor) + Number(row.costOther));
  }

  private checkType(value?: string): string {
    const type = String(value ?? 'CORRECTIVE').trim().toUpperCase();
    if (!(MAINTENANCE_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(`Unknown maintenance type "${value}" (${MAINTENANCE_TYPES.join(', ')})`);
    }
    return type;
  }

  private checkStatus(value?: string): string {
    const status = String(value ?? 'COMPLETED').trim().toUpperCase();
    if (!(MAINTENANCE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`Unknown maintenance status "${value}" (${MAINTENANCE_STATUSES.join(', ')})`);
    }
    return status;
  }

  private checkCosts(data: { costParts?: number; costLabor?: number; costOther?: number }) {
    const parts = Number(data.costParts ?? 0);
    const labor = Number(data.costLabor ?? 0);
    const other = Number(data.costOther ?? 0);
    for (const [label, value] of [['Parts', parts], ['Labor', labor], ['Other', other]] as const) {
      if (!Number.isFinite(value) || value < 0) throw new BadRequestException(`${label} cost must be 0 or more`);
    }
    return { parts, labor, other, total: round2(parts + labor + other) };
  }

  private async assertVendor(vendorId: string) {
    const vendor = await this.prisma.supplier.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new BadRequestException('Unknown vendor');
  }

  /**
   * Keep the asset cost ledger in step with this record: one SERVICE row per
   * record (sourceType=MAINTENANCE + sourceId=record id is unique), deleted
   * when the job ends up free or the record goes away.
   */
  private async syncCost(
    row: { id: string; assetId: string; date: Date | string; vendorId?: string | null; workDone?: string | null; problem?: string | null; code: string;
      costParts: unknown; costLabor: unknown; costOther: unknown },
  ) {
    const total = this.totalOf(row);
    if (total <= 0) {
      await this.prisma.assetCost.deleteMany({ where: { sourceType: 'MAINTENANCE', sourceId: row.id } });
      return;
    }
    const description = (row.workDone || row.problem || 'Service').slice(0, 200) + ' — ' + row.code;
    await this.prisma.assetCost.upsert({
      where: { sourceType_sourceId: { sourceType: 'MAINTENANCE', sourceId: row.id } },
      create: {
        assetId: row.assetId,
        date: new Date(row.date),
        kind: 'SERVICE',
        amount: total,
        supplierId: row.vendorId ?? undefined,
        description,
        sourceType: 'MAINTENANCE',
        sourceId: row.id,
        createdById: (row as any).createdById ?? undefined,
      },
      update: {
        date: new Date(row.date),
        amount: total,
        supplierId: row.vendorId ?? null,
        description,
      },
    });
  }
}
