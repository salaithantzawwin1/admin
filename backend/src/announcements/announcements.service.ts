import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AnnouncementPriority, AnnouncementStatus, AnnouncementTargetType, Prisma, RoleName } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../org/org.service';

const CATEGORIES = ['GENERAL', 'OFFICE', 'FACILITY', 'TRANSPORT', 'MEETING_ROOM', 'MAINTENANCE', 'SAFETY', 'HOLIDAY', 'IT', 'EMERGENCY', 'OTHER'] as const;
const PRIORITIES = ['NORMAL', 'IMPORTANT', 'URGENT', 'EMERGENCY'] as const;

export interface TargetInput {
  targetType: 'ALL' | 'DEPARTMENT' | 'ROLE' | 'EMPLOYEE' | 'BRANCH';
  targetId?: string;
}

@Injectable()
export class AnnouncementsService {
  private uploadRoot = process.env.UPLOAD_PATH || '/app/uploads';

  constructor(
    private prisma: PrismaService,
    private numbering: NumberingService,
    private notifications: NotificationsService,
    private audit: AuditService,
  ) {}

  // ---------- helpers ----------

  /** Resolve a target input to a label + validation against live org data. */
  private async resolveTarget(t: TargetInput): Promise<{ targetType: AnnouncementTargetType; targetId: string | null; targetLabel: string }> {
    switch (t.targetType) {
      case 'ALL':
        return { targetType: 'ALL', targetId: null, targetLabel: 'Everyone' };
      case 'DEPARTMENT': {
        if (!t.targetId) throw new BadRequestException('Department target requires targetId');
        const d = await this.prisma.department.findUnique({ where: { id: t.targetId } });
        if (!d) throw new BadRequestException('Department not found');
        return { targetType: 'DEPARTMENT', targetId: d.id, targetLabel: d.name };
      }
      case 'BRANCH': {
        if (!t.targetId) throw new BadRequestException('Branch target requires targetId');
        const b = await this.prisma.branch.findUnique({ where: { id: t.targetId } });
        if (!b) throw new BadRequestException('Branch not found');
        return { targetType: 'BRANCH', targetId: b.id, targetLabel: b.name };
      }
      case 'ROLE': {
        if (!t.targetId) throw new BadRequestException('Role target requires targetId');
        const roles = Object.values(RoleName);
        if (!roles.includes(t.targetId as never)) throw new BadRequestException('Unknown role');
        return { targetType: 'ROLE', targetId: t.targetId, targetLabel: t.targetId };
      }
      case 'EMPLOYEE': {
        if (!t.targetId) throw new BadRequestException('Employee target requires targetId');
        const u = await this.prisma.user.findUnique({ where: { id: t.targetId }, select: { id: true, fullName: true, status: true } });
        if (!u) throw new BadRequestException('User not found');
        return { targetType: 'EMPLOYEE', targetId: u.id, targetLabel: u.fullName };
      }
      default:
        throw new BadRequestException('Invalid target type');
    }
  }

  /** All users matching an announcement's targets (computed live — never a stale snapshot). */
  private async audienceIds(announcementId: string): Promise<string[]> {
    const targets = await this.prisma.announcementTarget.findMany({ where: { announcementId } });
    if (targets.length === 0) return [];
    if (targets.some((t) => t.targetType === 'ALL')) {
      const all = await this.prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
      return all.map((u) => u.id);
    }
    const ids = new Set<string>();
    for (const t of targets) {
      if (t.targetType === 'DEPARTMENT') {
        const rows = await this.prisma.employee.findMany({
          where: { departmentId: t.targetId!, user: { status: 'ACTIVE' } },
          select: { userId: true },
        });
        rows.forEach((r) => r.userId && ids.add(r.userId));
      } else if (t.targetType === 'BRANCH') {
        const rows = await this.prisma.employee.findMany({
          where: { branchId: t.targetId!, user: { status: 'ACTIVE' } },
          select: { userId: true },
        });
        rows.forEach((r) => r.userId && ids.add(r.userId));
      } else if (t.targetType === 'ROLE') {
        const rows = await this.prisma.userRole.findMany({
          where: { role: { name: t.targetId as never }, user: { status: 'ACTIVE' } },
          select: { userId: true },
        });
        rows.forEach((r) => ids.add(r.userId));
      } else if (t.targetType === 'EMPLOYEE') {
        const u = await this.prisma.user.findUnique({ where: { id: t.targetId! }, select: { id: true, status: true } });
        if (u?.status === 'ACTIVE') ids.add(u.id);
      }
    }
    return [...ids];
  }

  // ---------- admin CRUD ----------

  async create(data: {
    title: string; content: string; category?: string; priority?: string;
    publishAt?: string; endAt?: string; targets: TargetInput[];
  }, actor: Actor) {
    if (!data.title?.trim()) throw new BadRequestException('Title is required');
    if (!data.content?.trim()) throw new BadRequestException('Content is required');
    const category = (CATEGORIES as readonly string[]).includes(data.category || '') ? data.category : 'GENERAL';
    const priority = (PRIORITIES as readonly string[]).includes(data.priority || '') ? data.priority : 'NORMAL';
    if (!data.targets?.length) throw new BadRequestException('At least one target is required');
    const resolved = await Promise.all(data.targets.map((t) => this.resolveTarget(t)));

    const publishAt = data.publishAt ? new Date(data.publishAt) : null;
    const endAt = data.endAt ? new Date(data.endAt) : null;
    if (publishAt && endAt && endAt <= publishAt) throw new BadRequestException('End date must be after the publish date');

    // DRAFT if no publish date, SCHEDULED if future publish date
    const status: AnnouncementStatus = !publishAt ? 'DRAFT' : publishAt > new Date() ? 'SCHEDULED' : 'DRAFT';

    const a = await this.prisma.announcement.create({
      data: {
        code: await this.numbering.next('ANN'),
        title: data.title.trim(),
        content: data.content.trim(),
        category: category as never,
        priority: priority as never,
        status,
        publishAt,
        endAt,
        requiresAck: priority === 'IMPORTANT' || priority === 'URGENT' || priority === 'EMERGENCY',
        createdById: actor.userId,
        targets: { create: resolved },
      },
      include: { targets: true },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ANNOUNCEMENT_CREATED', module: 'ANNOUNCEMENT', recordId: a.id,
      newValue: { code: a.code, title: a.title, priority: a.priority, status: a.status },
    });
    return a;
  }

  async update(id: string, data: {
    title?: string; content?: string; category?: string; priority?: string; endAt?: string | null;
  }, actor: Actor) {
    const a = await this.prisma.announcement.findUnique({ where: { id }, include: { targets: true } });
    if (!a) throw new NotFoundException('Announcement not found');
    if (a.status === 'EXPIRED') throw new ConflictException('Expired announcements cannot be edited');

    // content edits after publish stay possible but are audit-logged (decision log 2026-09-23)
    const updated = await this.prisma.announcement.update({
      where: { id },
      data: {
        title: data.title?.trim(),
        content: data.content?.trim(),
        category: (CATEGORIES as readonly string[]).includes(data.category || '') ? data.category as never : undefined,
        priority: data.priority && (PRIORITIES as readonly string[]).includes(data.priority) ? data.priority as never : undefined,
        endAt: data.endAt === null ? null : data.endAt ? new Date(data.endAt) : undefined,
        requiresAck: data.priority
          ? ['IMPORTANT', 'URGENT', 'EMERGENCY'].includes(data.priority)
          : undefined,
      },
      include: { targets: true },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ANNOUNCEMENT_UPDATED', module: 'ANNOUNCEMENT', recordId: id,
      oldValue: { title: a.title, priority: a.priority, endAt: a.endAt, status: a.status },
      newValue: data,
    });
    return updated;
  }

  async remove(id: string, actor: Actor) {
    const a = await this.prisma.announcement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Announcement not found');
    // DRAFT/SCHEDULED can be deleted; published history must be kept (Plan §18)
    if (a.status === 'PUBLISHED' || a.status === 'EXPIRED') {
      throw new ConflictException('Published announcements stay in history — set an end date to expire it instead');
    }
    // delete attachment files (DB rows cascade) before dropping the announcement
    const files = await this.prisma.attachment.findMany({ where: { announcementId: id }, select: { storedName: true } });
    await this.prisma.announcement.delete({ where: { id } });
    for (const f of files) {
      const p = path.join(this.uploadRoot, f.storedName);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ANNOUNCEMENT_DELETED', module: 'ANNOUNCEMENT', recordId: id,
      oldValue: { code: a.code, title: a.title }, severity: 'WARNING',
    });
    return { success: true };
  }

  async publish(id: string, actor: Actor) {
    const a = await this.prisma.announcement.findUnique({ where: { id }, include: { targets: true } });
    if (!a) throw new NotFoundException('Announcement not found');
    if (a.status === 'PUBLISHED') throw new ConflictException('Already published');
    if (a.status === 'EXPIRED') throw new ConflictException('Expired announcements cannot be republished');

    const now = new Date();
    const updated = await this.prisma.announcement.update({
      where: { id },
      data: { status: 'PUBLISHED', publishAt: a.publishAt && a.publishAt <= now ? a.publishAt : now },
    });

    // notify the target audience (in-app + Telegram mirror)
    const userIds = await this.audienceIds(id);
    await this.notifications.notifyMany([...new Set(userIds)], {
      type: 'ANNOUNCEMENT',
      title: `${a.priority === 'NORMAL' ? 'Announcement' : a.priority} — ${a.title}`,
      body: a.content.slice(0, 300),
      link: '/announcements',
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ANNOUNCEMENT_PUBLISHED', module: 'ANNOUNCEMENT', recordId: id,
      newValue: { code: a.code, audience: userIds.length },
    });
    return updated;
  }

  // ---------- admin views ----------

  listAll() {
    return this.prisma.announcement.findMany({
      orderBy: [{ createdAt: 'desc' }],
      include: { targets: true, createdBy: { select: { fullName: true } }, _count: { select: { reads: true } } },
    });
  }

  /** Target/read/unread for the tracking view (IMPORTANT+ only, Plan §18). */
  async readStats(id: string) {
    const a = await this.prisma.announcement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Announcement not found');
    const audience = await this.audienceIds(id);
    const reads = await this.prisma.announcementRead.findMany({ where: { announcementId: id } });
    const readUserIds = new Set(reads.filter((r) => r.ackAt).map((r) => r.userId));
    const readSet = new Set(reads.map((r) => r.userId));
    return {
      target: audience.length,
      read: audience.filter((u) => readSet.has(u)).length,
      unread: audience.filter((u) => !readSet.has(u)).length,
      acked: audience.filter((u) => readUserIds.has(u)).length,
      requiresAck: a.requiresAck,
      readRows: reads.map((r) => ({ userId: r.userId, readAt: r.readAt, ackAt: r.ackAt })),
    };
  }

  // ---------- employee views ----------

  /** Announcements visible to the current user (published, in window, targeted). */
  async listMine(actor: Actor) {
    const roles = await this.prisma.userRole.findMany({ where: { userId: actor.userId }, include: { role: true } });
    const roleNames = roles.map((r) => r.role.name as string);
    const now = new Date();
    const deptRows = await this.prisma.employee.findFirst({ where: { userId: actor.userId }, select: { departmentId: true, branchId: true } });

    // visible = PUBLISHED, publishAt <= now, endAt not passed, and targeted at me
    const rows = await this.prisma.announcement.findMany({
      where: {
        status: 'PUBLISHED',
        publishAt: { lte: now },
        OR: [{ endAt: null }, { endAt: { gt: now } }],
        AND: [
          {
            OR: [
              { targets: { some: { targetType: 'ALL' } } },
              { targets: { some: { targetType: 'EMPLOYEE', targetId: actor.userId } } },
              { targets: { some: { targetType: 'ROLE', targetId: { in: roleNames } } } },
              ...(deptRows?.departmentId ? [{ targets: { some: { targetType: 'DEPARTMENT' as const, targetId: deptRows.departmentId } } }] : []),
              ...(deptRows?.branchId ? [{ targets: { some: { targetType: 'BRANCH' as const, targetId: deptRows.branchId } } }] : []),
            ],
          },
        ],
      },
      orderBy: [
        { priority: 'desc' },
        { publishAt: 'desc' },
      ],
      include: {
        targets: true,
        reads: { where: { userId: actor.userId }, select: { readAt: true, ackAt: true } },
        createdBy: { select: { fullName: true } },
      },
      take: 50,
    });
    return (rows as unknown as Array<Prisma.AnnouncementGetPayload<{ include: { targets: true; reads: { where: { userId: string }; select: { readAt: true; ackAt: true } }; createdBy: { select: { fullName: true } } } }>>).map((a) => ({
      id: a.id, code: a.code, title: a.title, content: a.content, category: a.category,
      priority: a.priority, publishAt: a.publishAt, startAt: a.startAt, endAt: a.endAt,
      requiresAck: a.requiresAck, createdBy: a.createdBy.fullName,
      read: a.reads.length > 0, acked: a.reads[0]?.ackAt ?? null,
    }));
  }

  /** Mark read on open; returns the announcement if visible to the user. */
  async markRead(id: string, actor: Actor) {
    const mine = await this.listMine(actor);
    const a = mine.find((x) => x.id === id);
    if (!a) throw new ForbiddenException('Not visible to you');
    await this.prisma.announcementRead.upsert({
      where: { announcementId_userId: { announcementId: id, userId: actor.userId } },
      update: {},
      create: { announcementId: id, userId: actor.userId },
    });
    return { success: true };
  }

  async ack(id: string, actor: Actor) {
    const mine = await this.listMine(actor);
    const a = mine.find((x) => x.id === id);
    if (!a) throw new ForbiddenException('Not visible to you');
    if (!a.requiresAck) throw new BadRequestException('This announcement does not require acknowledgement');
    await this.prisma.announcementRead.upsert({
      where: { announcementId_userId: { announcementId: id, userId: actor.userId } },
      update: { ackAt: new Date() },
      create: { announcementId: id, userId: actor.userId, ackAt: new Date() },
    });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ANNOUNCEMENT_ACKED', module: 'ANNOUNCEMENT', recordId: id,
    });
    return { success: true };
  }

  // ---------- crons ----------

  /** Hourly: SCHEDULED → PUBLISHED when publishAt arrives; PUBLISHED → EXPIRED after endAt. */
  @Cron('0 5 * * * *')
  async lifecycleCron() {
    const now = new Date();
    const toPublish = await this.prisma.announcement.updateMany({
      where: { status: 'SCHEDULED', publishAt: { lte: now } },
      data: { status: 'PUBLISHED' },
    });
    const toExpire = await this.prisma.announcement.updateMany({
      where: { status: 'PUBLISHED', endAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    if (toPublish.count > 0) console.log(`[announcements] published ${toPublish.count} scheduled announcement(s)`);
    if (toExpire.count > 0) console.log(`[announcements] expired ${toExpire.count} announcement(s)`);
  }
}
