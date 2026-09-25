import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';

/**
 * Company Time Table — the office hours used company-wide.
 *
 * Stored in system_settings under `timetable.company` as JSON. Consumers:
 *  - Fleet → Driver Absences: a leave is recorded as Full day / Half day
 *    (Morning | Evening) and its concrete start/end window is derived from
 *    this table, so admins never re-enter clock times per absence.
 *
 * All times are "HH:MM" 24h strings (Asia/Yangon office time).
 */
export interface CompanyTimetable {
  /** Workday start, e.g. "08:00" */
  workStart: string;
  /** Workday end, e.g. "17:30" */
  workEnd: string;
  /** Boundary that splits Morning | Evening half-days, e.g. "12:30" */
  halfDaySplit: string;
  /** Working days (0=Sun … 6=Sat) — used by future scheduling features */
  workDays: number[];
}

export const DEFAULT_TIMETABLE: CompanyTimetable = {
  workStart: '08:00',
  workEnd: '17:30',
  halfDaySplit: '12:30',
  workDays: [1, 2, 3, 4, 5], // Mon–Fri
};

const KEY = 'timetable.company';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validate(tt: Partial<CompanyTimetable>): CompanyTimetable {
  for (const f of ['workStart', 'workEnd', 'halfDaySplit'] as const) {
    if (typeof tt[f] !== 'string' || !TIME_RE.test(tt[f] as string)) {
      throw new BadRequestException(`${f} must be a HH:MM time (24h)`);
    }
  }
  const { workStart, halfDaySplit, workEnd } = tt as Required<Pick<CompanyTimetable, 'workStart' | 'halfDaySplit' | 'workEnd'>>;
  if (!(workStart < halfDaySplit && halfDaySplit < workEnd)) {
    throw new BadRequestException('Times must be ordered: work start < half-day split < work end');
  }
  const workDays = Array.isArray(tt.workDays) ? [...new Set(tt.workDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : DEFAULT_TIMETABLE.workDays;
  return { workStart, workEnd, halfDaySplit, workDays };
}

@Injectable()
export class TimetableService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async get(): Promise<CompanyTimetable> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: KEY } });
    if (!row?.value) return { ...DEFAULT_TIMETABLE };
    try {
      const parsed = JSON.parse(row.value) as Partial<CompanyTimetable>;
      // tolerate a stored-but-invalid value by falling back per-field
      return {
        workStart: TIME_RE.test(parsed.workStart ?? '') ? parsed.workStart! : DEFAULT_TIMETABLE.workStart,
        workEnd: TIME_RE.test(parsed.workEnd ?? '') ? parsed.workEnd! : DEFAULT_TIMETABLE.workEnd,
        halfDaySplit: TIME_RE.test(parsed.halfDaySplit ?? '') ? parsed.halfDaySplit! : DEFAULT_TIMETABLE.halfDaySplit,
        workDays: Array.isArray(parsed.workDays) && parsed.workDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
          ? parsed.workDays
          : DEFAULT_TIMETABLE.workDays,
      };
    } catch {
      return { ...DEFAULT_TIMETABLE };
    }
  }

  async update(dto: Partial<CompanyTimetable>, actor: { userId: string; username: string }): Promise<CompanyTimetable> {
    const next = validate({ ...(await this.get()), ...dto });
    const before = await this.get();
    await this.prisma.systemSetting.upsert({
      where: { key: KEY },
      update: { value: JSON.stringify(next) },
      create: { key: KEY, value: JSON.stringify(next) },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'TIMETABLE_UPDATED', module: 'SETTINGS', recordId: KEY,
      oldValue: before, newValue: next,
    });
    return next;
  }
}
