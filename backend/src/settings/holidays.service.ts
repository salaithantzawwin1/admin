import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';

export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KEY = (year: number) => `holidays.${year}`;

/**
 * Myanmar public holidays — fixed-date defaults per year. Lunar festivals
 * (Thadingyut, Tazaungdaing, Eid, Diwali, Kayin New Year, National Day…)
 * move every year: administrators can maintain the exact list per year via
 * PUT /settings/holidays/:year (users.manage) — the stored list always
 * overrides these defaults.
 */
const DEFAULT_HOLIDAYS: Record<number, Holiday[]> = {
  2026: [
    { date: '2026-01-01', name: "New Year's Day" },
    { date: '2026-01-04', name: 'Independence Day' },
    { date: '2026-02-12', name: 'Union Day' },
    { date: '2026-03-02', name: "Peasants' Day" },
    { date: '2026-03-27', name: 'Armed Forces Day' },
    { date: '2026-04-13', name: 'Thingyan (Water Festival)' },
    { date: '2026-04-14', name: 'Thingyan (Water Festival)' },
    { date: '2026-04-15', name: 'Myanmar New Year Day' },
    { date: '2026-04-16', name: 'Thingyan holiday' },
    { date: '2026-04-17', name: 'Thingyan holiday' },
    { date: '2026-05-01', name: 'Labour Day' },
    { date: '2026-07-19', name: "Martyrs' Day" },
    { date: '2026-12-25', name: 'Christmas Day' },
  ],
};

@Injectable()
export class HolidaysService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Holiday list for a year — the admin-maintained list or the defaults. */
  async list(year: number): Promise<Holiday[]> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new BadRequestException('Invalid year');
    const row = await this.prisma.systemSetting.findUnique({ where: { key: KEY(year) } });
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value) as unknown;
        if (Array.isArray(parsed)) {
          return (parsed as Holiday[]).filter((h) => h && DATE_RE.test(h.date ?? '') && typeof h.name === 'string' && h.name.trim() !== '');
        }
      } catch {
        // corrupted value → fall through to defaults
      }
    }
    return DEFAULT_HOLIDAYS[year] ?? [];
  }

  /** Replace the holiday list for a year (System Admin). */
  async update(year: number, holidays: Holiday[], actor?: { userId?: string; username?: string }): Promise<Holiday[]> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new BadRequestException('Invalid year');
    if (!Array.isArray(holidays)) throw new BadRequestException('holidays must be an array');
    const seen = new Set<string>();
    for (const h of holidays) {
      if (!h || !DATE_RE.test(h.date ?? '') || typeof h.name !== 'string' || !h.name.trim()) {
        throw new BadRequestException('Each holiday needs date (YYYY-MM-DD) and name');
      }
      if (Number(h.date.slice(0, 4)) !== year) throw new BadRequestException(`Holiday ${h.date} does not belong to ${year}`);
      if (seen.has(h.date)) throw new BadRequestException(`Duplicate date ${h.date}`);
      seen.add(h.date);
    }
    const sorted = [...holidays].sort((a, b) => a.date.localeCompare(b.date)).map((h) => ({ date: h.date, name: h.name.trim() }));
    const before = await this.list(year);
    await this.prisma.systemSetting.upsert({
      where: { key: KEY(year) },
      update: { value: JSON.stringify(sorted) },
      create: { key: KEY(year), value: JSON.stringify(sorted) },
    });
    await this.audit.log({
      userId: actor?.userId || undefined,
      username: actor?.username ?? 'system',
      action: 'HOLIDAYS_UPDATED',
      module: 'SETTINGS',
      recordId: `holidays.${year}`,
      oldValue: { count: before.length, holidays: before },
      newValue: { count: sorted.length, holidays: sorted },
    });
    return sorted;
  }
}
