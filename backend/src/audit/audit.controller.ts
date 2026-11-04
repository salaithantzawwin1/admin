import { BadRequestException, Controller, Get, NotFoundException, Param, Query, Res, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { csvRow } from '../util/csv';

const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

class FindAuditQuery {
  @IsOptional() @IsString() @MaxLength(64) module?: string;
  @IsOptional() @IsString() @MaxLength(120) action?: string;
  @IsOptional() @IsString() @MaxLength(120) username?: string;
  @IsOptional() @IsString() @MaxLength(64) ip?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsIn(SEVERITIES) severity?: (typeof SEVERITIES)[number];
  /** YYYY-MM-DD (Yangon day) or a full ISO timestamp. */
  @IsOptional() @IsString() @MaxLength(40) from?: string;
  @IsOptional() @IsString() @MaxLength(40) to?: string;
  @IsOptional() @IsString() @MaxLength(10) page?: string;
  @IsOptional() @IsString() @MaxLength(10) pageSize?: string;
}

/** The columns the list and the CSV both read. */
const LIST_SELECT = {
  id: true,
  username: true,
  action: true,
  module: true,
  recordId: true,
  ipAddress: true,
  userAgent: true,
  severity: true,
  createdAt: true,
} as const;

/**
 * Best-effort client platform from the recorded user agent. It is a label for
 * humans reading the trail, never an authorisation signal.
 */
export function platformFromUserAgent(ua?: string | null): 'Desktop' | 'Mobile' | 'Tablet' | 'Bot' | 'Unknown' {
  if (!ua) return 'Unknown';
  const s = ua.toLowerCase();
  if (/bot|crawler|spider|curl\/|wget|python-|node-fetch|postmanruntime/.test(s)) return 'Bot';
  if (/ipad|tablet|playbook|silk|kindle/.test(s)) return 'Tablet';
  if (/android/.test(s) && !/mobile/.test(s)) return 'Tablet';
  if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile|windows phone/.test(s)) return 'Mobile';
  return 'Desktop';
}

/** Date filter → instant. A bare date is the Yangon day, not the host's. */
function parseDay(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (!value || !value.trim()) return undefined;
  const v = value.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? new Date(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+06:30`)
    : new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Date filters must be a date (YYYY-MM-DD) or ISO timestamp');
  return d;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@RequirePermissions(PERMISSIONS.AUDIT_READ)
@Controller('audit-logs')
export class AuditController {
  constructor(private prisma: PrismaService) {}

  /** Shared filter → Prisma `where`, used by the list and the CSV export. */
  private where(q: FindAuditQuery) {
    const and: Record<string, unknown>[] = [];
    if (q.module) and.push({ module: q.module });
    if (q.action) and.push({ action: q.action });
    if (q.username) and.push({ username: q.username });
    if (q.severity) and.push({ severity: q.severity });
    if (q.ip?.trim()) and.push({ ipAddress: { contains: q.ip.trim() } });

    const term = q.q?.trim();
    if (term) {
      and.push({
        OR: [
          { action: { contains: term, mode: 'insensitive' } },
          { username: { contains: term, mode: 'insensitive' } },
          { module: { contains: term, mode: 'insensitive' } },
          { recordId: { contains: term, mode: 'insensitive' } },
          { ipAddress: { contains: term } },
          { userAgent: { contains: term, mode: 'insensitive' } },
        ],
      });
    }

    const from = parseDay(q.from, false);
    const to = parseDay(q.to, true);
    if (from && to && from > to) throw new BadRequestException('The start date must be before the end date');
    if (from || to) and.push({ createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });

    return and.length ? { AND: and } : {};
  }

  @Get()
  async findAll(@Query() q: FindAuditQuery) {
    const page = clampInt(q.page, 1, 1, 100000);
    const pageSize = clampInt(q.pageSize, 25, 1, 100);
    const where = this.where(q);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: LIST_SELECT,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: items.map((r) => ({ ...r, platform: platformFromUserAgent(r.userAgent) })),
      total,
      page,
      pageSize,
    };
  }

  /** Filter options — the distinct users / actions / modules that actually occur. */
  @Get('filters')
  async filters() {
    const [users, actions, modules] = await Promise.all([
      this.prisma.auditLog.findMany({ distinct: ['username'], select: { username: true }, orderBy: { username: 'asc' }, take: 300 }),
      this.prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' }, take: 400 }),
      this.prisma.auditLog.findMany({ distinct: ['module'], select: { module: true }, orderBy: { module: 'asc' }, take: 100 }),
    ]);
    return {
      users: users.map((u) => u.username).filter((u): u is string => !!u),
      actions: actions.map((a) => a.action),
      modules: modules.map((m) => m.module),
      severities: SEVERITIES,
    };
  }

  /**
   * Filtered export for auditors. Capped so one click cannot stream the whole
   * history through the API process; cells go through the shared CSV guard.
   */
  @Get('export.csv')
  async exportCsv(@Query() q: FindAuditQuery, @Res() res: Response) {
    const rows = await this.prisma.auditLog.findMany({
      where: this.where(q),
      orderBy: { createdAt: 'desc' },
      take: 5000,
      select: LIST_SELECT,
    });
    const body = [
      csvRow(['Time (Yangon)', 'User', 'Action', 'Module', 'Record', 'Severity', 'IP', 'Platform', 'User agent']),
      ...rows.map((r) =>
        csvRow([
          new Date(r.createdAt.getTime() + 6.5 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19),
          r.username ?? '',
          r.action,
          r.module,
          r.recordId ?? '',
          r.severity,
          r.ipAddress ?? '',
          platformFromUserAgent(r.userAgent),
          // the UA is long and the sheet only needs enough to identify the device
          (r.userAgent ?? '').slice(0, 120),
        ]),
      ),
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    // BOM so Excel reads the Myanmar text as UTF-8
    res.send('\uFEFF' + body);
  }

  /** Full record for the row detail drawer (old/new values, user agent). */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new NotFoundException('Audit entry not found');
    }
    const row = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Audit entry not found');
    return { ...row, platform: platformFromUserAgent(row.userAgent) };
  }
}
