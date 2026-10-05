import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';

/**
 * Company Time Table — the office hours used company-wide.
 *
 * Stored in system_settings under `timetable.company` as JSON. Consumers:
 *  - Fleet → Driver Absences: a leave is recorded as Full day / Half day
 *    (Morning | Evening) and its concrete start/end window comes straight
 *    from the matching range here, so admins never re-enter clock times
 *    per absence. The three ranges are independent — e.g. a Morning half
 *    can end at 12:00 while Full day ends at 17:30.
 *
 * Legacy note: earlier versions stored a single {workStart, halfDaySplit,
 * workEnd} triple; `normalize()` maps that shape to
 * {fullStart..fullEnd, morningStart..morningEnd, eveningStart..eveningEnd}
 * so no data migration is needed.
 *
 * All times are "HH:MM" 24h strings (Asia/Yangon office time).
 */
export interface CompanyTimetable {
  /** Full-day leave range, e.g. "08:00" … "17:30" */
  fullStart: string;
  fullEnd: string;
  /** Morning half-day leave range, e.g. "08:00" … "12:00" */
  morningStart: string;
  morningEnd: string;
  /** Evening half-day leave range, e.g. "13:00" … "17:30" */
  eveningStart: string;
  eveningEnd: string;
  /** Working days (0=Sun … 6=Sat) — used by future scheduling features */
  workDays: number[];
}

export const DEFAULT_TIMETABLE: CompanyTimetable = {
  fullStart: '08:00',
  fullEnd: '17:30',
  morningStart: '08:00',
  morningEnd: '12:30',
  eveningStart: '12:30',
  eveningEnd: '17:30',
  workDays: [1, 2, 3, 4, 5], // Mon–Fri
};

const KEY = 'timetable.company';
/** Settings key for the fleet hand-back buffer (feature: "likely free from ~end+buffer"). */
const FLEET_BUFFER_KEY = 'fleet.bufferMinutes';
/** Default hand-back buffer shown/used when nothing is configured (30 min). */
export const DEFAULT_FLEET_BUFFER_MINUTES = 30;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Accept either the new 3-range shape or the legacy 3-field triple. */
function normalize(input: Partial<CompanyTimetable>): CompanyTimetable {
  const time = (v: unknown, fallback: string): string =>
    typeof v === 'string' && TIME_RE.test(v) ? v : fallback;

  // legacy shape → derive the three ranges from workStart/halfDaySplit/workEnd
  const legacyFullStart = typeof (input as Record<string, unknown>).workStart === 'string' ? (input as Record<string, string>).workStart : undefined;
  const legacySplit = typeof (input as Record<string, unknown>).halfDaySplit === 'string' ? (input as Record<string, string>).halfDaySplit : undefined;
  const legacyFullEnd = typeof (input as Record<string, unknown>).workEnd === 'string' ? (input as Record<string, string>).workEnd : undefined;

  const workDays = Array.isArray(input.workDays) && input.workDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    ? [...new Set(input.workDays)].sort((a, b) => a - b)
    : [...DEFAULT_TIMETABLE.workDays];

  return {
    fullStart: time(input.fullStart, legacyFullStart ?? DEFAULT_TIMETABLE.fullStart),
    fullEnd: time(input.fullEnd, legacyFullEnd ?? DEFAULT_TIMETABLE.fullEnd),
    morningStart: time(input.morningStart, legacyFullStart ?? DEFAULT_TIMETABLE.morningStart),
    morningEnd: time(input.morningEnd, legacySplit ?? DEFAULT_TIMETABLE.morningEnd),
    eveningStart: time(input.eveningStart, legacySplit ?? DEFAULT_TIMETABLE.eveningStart),
    eveningEnd: time(input.eveningEnd, legacyFullEnd ?? DEFAULT_TIMETABLE.eveningEnd),
    workDays,
  };
}

function validate(tt: CompanyTimetable): CompanyTimetable {
  if (!(tt.fullStart < tt.fullEnd)) throw new BadRequestException('Full Day times must be ordered: start < end');
  if (!(tt.morningStart < tt.morningEnd)) throw new BadRequestException('Half Day (Morning) times must be ordered: start < end');
  if (!(tt.eveningStart < tt.eveningEnd)) throw new BadRequestException('Half Day (Evening) times must be ordered: start < end');
  return { ...tt, workDays: [...tt.workDays] };
}

@Injectable()
export class TimetableService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async get(): Promise<CompanyTimetable> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: KEY } });
    if (!row?.value) return { ...DEFAULT_TIMETABLE, workDays: [...DEFAULT_TIMETABLE.workDays] };
    try {
      // normalize() also upgrades the legacy workStart/halfDaySplit/workEnd shape
      return validate(normalize(JSON.parse(row.value) as Partial<CompanyTimetable>));
    } catch {
      return { ...DEFAULT_TIMETABLE, workDays: [...DEFAULT_TIMETABLE.workDays] };
    }
  }

  async update(dto: Partial<CompanyTimetable>, actor: { userId: string; username: string }): Promise<CompanyTimetable> {
    const next = validate(normalize({ ...(await this.get()), ...dto }));
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

  /**
   * Fleet hand-back buffer (minutes): how long a car typically needs after the
   * planned end for parking / handover before it is realistically free again.
   * The fleet availability card and the conflict pre-warning show
   * "likely free from ~end + buffer". Stored under `fleet.bufferMinutes`.
   */
  async fleetBufferMinutes(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: FLEET_BUFFER_KEY } });
    const n = row?.value == null ? NaN : Number(JSON.parse(row.value));
    return Number.isFinite(n) && n >= 0 && n <= 240 ? n : DEFAULT_FLEET_BUFFER_MINUTES;
  }

  /** Set the hand-back buffer (0–240 minutes; 0 disables the hint). */
  async setFleetBufferMinutes(minutes: number, actor: { userId: string; username: string }): Promise<number> {
    const n = Math.round(Number(minutes));
    if (!Number.isFinite(n) || n < 0 || n > 240) throw new BadRequestException('Buffer must be 0–240 minutes');
    const before = await this.fleetBufferMinutes();
    await this.prisma.systemSetting.upsert({
      where: { key: FLEET_BUFFER_KEY },
      update: { value: JSON.stringify(n) },
      create: { key: FLEET_BUFFER_KEY, value: JSON.stringify(n) },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'FLEET_BUFFER_UPDATED', module: 'SETTINGS', recordId: FLEET_BUFFER_KEY,
      oldValue: { minutes: before }, newValue: { minutes: n },
    });
    return n;
  }
}
