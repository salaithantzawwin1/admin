import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AnnouncementPriority, AnnouncementStatus, AnnouncementTargetType, Prisma, RoleName } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.module';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { InboundCaptureInput, InboundHandledBy, TelegramService } from '../telegram/telegram.service';
import { EventsService } from '../events/events.service';
import { Actor } from '../org/org.service';
import { htmlToText, sanitizeHtml } from './sanitize-html';

const CATEGORIES = ['GENERAL', 'OFFICE', 'FACILITY', 'TRANSPORT', 'MEETING_ROOM', 'MAINTENANCE', 'SAFETY', 'HOLIDAY', 'IT', 'EMERGENCY', 'OTHER'] as const;
const PRIORITIES = ['NORMAL', 'IMPORTANT', 'URGENT', 'EMERGENCY'] as const;

/** Only a raise counts as news (F5) — lowering a priority re-notifies nobody. */
const PRIORITY_RANK: Record<string, number> = { NORMAL: 0, IMPORTANT: 1, URGENT: 2, EMERGENCY: 3 };

/** Escape a plain string for Telegram's HTML parse mode. */
const escapeTgHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Never keep a live binding code in the log: `/start USR-ABCDEF` is stored as
 * `/start ••••` so the Messages tab cannot be used to link someone else's chat
 * (plan §6).
 */
const maskInboundText = (text: string): string => {
  const t = text.trim();
  if (!/^\/start(@\w+)?(\s|$)/i.test(t)) return t;
  const rest = t.replace(/^\/start(@\w+)?/i, '').trim();
  return rest ? '/start ••••' : '/start';
};

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
    private telegram: TelegramService,
    private events?: EventsService,
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
        // rich text is stored as sanitized HTML — scripts/styles/event handlers never survive
        content: sanitizeHtml(data.content.trim()),
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
        content: data.content !== undefined ? sanitizeHtml(data.content.trim()) : undefined,
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
    // F5: raising the priority of a live notice is the admin saying "this got
    // serious". People who already scrolled past it never look again, so the
    // ack prompt goes out once more — to those who have not acked, because a
    // second card for someone who already did is pure noise (plan §9.4 F5).
    const raised = a.status === 'PUBLISHED'
      && (PRIORITY_RANK[updated.priority] ?? 0) > (PRIORITY_RANK[a.priority] ?? 0);
    if (raised) {
      await this.reNotifyPriorityRaise(updated, a.priority, actor).catch((e) =>
        console.warn(`[announcements] priority re-notify failed for ${id}: ${(e as Error).message}`));
    }
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

  /**
   * Unpublish — pull a live announcement back to DRAFT.
   * The audience keeps its read/ack history for the records; the announcement
   * simply stops being visible (listMine only shows PUBLISHED) and can be
   * edited or re-published afterwards.
   */
  async unpublish(id: string, actor: Actor) {
    const a = await this.prisma.announcement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Announcement not found');
    if (a.status !== 'PUBLISHED') throw new ConflictException('Only published announcements can be unpublished');
    const updated = await this.prisma.announcement.update({ where: { id }, data: { status: 'DRAFT' } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ANNOUNCEMENT_UNPUBLISHED', module: 'ANNOUNCEMENT', recordId: id,
      oldValue: { code: a.code, status: 'PUBLISHED' },
      newValue: { code: a.code, status: 'DRAFT' },
    });
    return updated;
  }

  /** Toggle the pin — pinned announcements float to the top of every list. */
  async togglePin(id: string, actor: Actor) {
    const a = await this.prisma.announcement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Announcement not found');
    const pinnedAt = a.pinnedAt ? null : new Date();
    const updated = await this.prisma.announcement.update({ where: { id }, data: { pinnedAt } });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: pinnedAt ? 'ANNOUNCEMENT_PINNED' : 'ANNOUNCEMENT_UNPINNED', module: 'ANNOUNCEMENT', recordId: id,
      newValue: { code: a.code, pinned: !!pinnedAt },
    });
    return updated;
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

    await this.deliverPublished(updated, { userId: actor.userId, username: actor.username, via: 'publish' });
    return updated;
  }

  /**
   * Deliver a published announcement to its audience — in-app notification,
   * Telegram mirror, photo album and the announcement card (with the ✓
   * Acknowledge button on IMPORTANT+).
   *
   * Shared by the manual Publish action and the scheduled lifecycle cron: a
   * scheduled notice must reach people exactly like a hand-published one. The
   * cron used to flip the status with a bulk updateMany and notify nobody, so a
   * scheduled URGENT announcement arrived in silence with no acknowledge
   * button (plan §1 G1 / P0.5 F1).
   */
  private async deliverPublished(
    a: { id: string; code: string; title: string; content: string; priority: string; requiresAck: boolean },
    actor: { userId?: string; username?: string; via: 'publish' | 'schedule' },
  ) {
    const userIds = [...new Set(await this.audienceIds(a.id))];
    const notifBody = htmlToText(a.content).slice(0, 300) || a.title;
    await this.notifications.notifyMany(userIds, {
      type: 'ANNOUNCEMENT',
      title: `${a.priority === 'NORMAL' ? 'Announcement' : a.priority} — ${a.title}`,
      // Telegram/notification channels take plain text — strip the rich-text markup
      body: notifBody,
      link: '/announcements',
      // F9: the announcement card below *is* the Telegram message. The mirror
      // used to send a second, plainer message to the same chat for every
      // publish, so each subscriber got two notifications for one notice.
      skipTelegram: true,
    });
    // photos + card (ack button on IMPORTANT+) ride along for anyone bound to the bot
    await this.sendPhotosToAudience(a.id, userIds, {
      id: a.id, code: a.code, title: a.title, priority: a.priority, requiresAck: a.requiresAck,
    }, notifBody);
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ANNOUNCEMENT_PUBLISHED', module: 'ANNOUNCEMENT', recordId: a.id,
      newValue: { code: a.code, audience: userIds.length, via: actor.via },
    });
  }

  /**
   * After publish, push the announcement to every audience member's Telegram
   * chat — photos as a real album, then a text card; IMPORTANT+ notices carry
   * a ✓ Acknowledge button (callback anack:<id>) that records the ack without
   * opening AMS. Best-effort, never blocks the publish.
   */
  private async sendPhotosToAudience(announcementId: string, userIds: string[], a: { id: string; code: string; title: string; priority: string; requiresAck: boolean }, body: string, opts: { album?: boolean } = {}) {
    try {
      // a re-notify sends only the card — the photos were already seen (F5)
      const photos = opts.album === false ? [] : await this.prisma.attachment.findMany({
        where: { announcementId, mimeType: { startsWith: 'image/' } },
        orderBy: { createdAt: 'asc' },
        take: 10,
      });
      const files = photos.map((p) => path.join(this.uploadRoot, p.storedName));
      const caption = `🖼 <b>${a.priority === 'NORMAL' ? 'Announcement' : a.priority} — ${escapeTgHtml(a.title)}</b> (${a.code})\n${escapeTgHtml(body.slice(0, 300))}`;
      // EVERY bound recipient gets the card. The old `slice(0, 100)` silently
      // dropped the card — and with it the ✓ Acknowledge button — for anyone
      // past the 100th audience member, so acknowledgement stats were wrong on
      // large audiences (plan §13.1 D3 / P0.5 F10). Batched to stay inside
      // Telegram's ~30 messages/second global limit.
      const BATCH = 25;
      let sent = 0;
      let failed = 0;
      for (let i = 0; i < userIds.length; i += BATCH) {
        const chunk = userIds.slice(i, i + BATCH);
        const bound = await this.prisma.user.findMany({
          where: { id: { in: chunk }, telegramChatId: { not: null } },
          select: { id: true, telegramChatId: true },
        });
        for (const u of bound) {
          if (!u.telegramChatId) continue;
          try {
            const album = files.length > 0 ? await this.telegram.sendPhotoAlbum(u.telegramChatId, files, caption) : null;
            const card = await this.telegram.sendAnnouncementCard(u.telegramChatId, a, body);
            await this.recordChatSend(announcementId, u.telegramChatId, [
              ...(card ? [card.message_id] : []),
              ...(album ?? []).map((m) => m.message_id),
            ]);
            sent += 1;
          } catch {
            failed += 1;
            // F9 dropped the text mirror, so the card is the only Telegram copy
            // of this notice: if it fails, fall back to plain text rather than
            // leaving that chat with nothing at all.
            await this.telegram.mirrorToUser(u.id, `📢 ${a.title}`, body.slice(0, 300), '/announcements')
              .catch(() => undefined);
          }
        }
        if (i + BATCH < userIds.length) await new Promise((r) => setTimeout(r, 200));
      }
      await this.audit.log({
        action: 'ANNOUNCEMENT_PHOTOS_TELEGRAM', module: 'ANNOUNCEMENT', recordId: announcementId,
        newValue: { code: a.code, photos: files.length, audience: userIds.length, recipients: sent, failed, ackButton: a.requiresAck },
      });
    } catch {
      /* photos-in-Telegram is a bonus — never fail the publish */
    }
  }

  /**
   * Remember the Telegram message ids we sent for this announcement in each chat
   * (the card and every album photo), so a subscriber's Reply — which carries
   * reply_to_message.message_id — can be matched to the exact announcement it
   * answers instead of guessing from the newest card in the chat (plan §5 / P3).
   * Bookkeeping only: a failure is logged and never breaks delivery.
   */
  private async recordChatSend(announcementId: string, chatId: string, messageIds: number[]) {
    const ids = [...new Set(messageIds.filter((id) => Number.isFinite(id)))];
    if (ids.length === 0) return;
    try {
      await this.prisma.announcementChatSend.createMany({
        data: ids.map((messageId) => ({ announcementId, chatId, messageId: BigInt(messageId) })),
        skipDuplicates: true,
      });
    } catch (e) {
      console.warn(`[announcements] could not record telegram message ids for chat ${chatId}: ${(e as Error).message}`);
    }
  }

  // ---------- inbound subscriber messages (plan §6 / P4) ----------

  /**
   * Store one message a subscriber sent the bot — text, photo or document — and
   * work out who sent it and which announcement (if any) it answers.
   *
   * Nothing here may throw into the Telegram poll loop, and nothing here may
   * consume the update: the caller routes it afterwards exactly as before and
   * labels the row with `markHandled()`. Set `TELEGRAM_INBOUND=0` to switch the
   * whole capture path off (the old behaviour, minus a restart only).
   */
  async captureInbound(
    input: InboundCaptureInput,
  ): Promise<{ id: string; announcementId: string | null } | null> {
    if (process.env.TELEGRAM_INBOUND === '0') return null;
    try {
      const kind = input.photo ? 'PHOTO' : input.documentName ? 'DOCUMENT' : 'TEXT';
      // sender: a bound AMS user first, then a bound driver (driver-only chat)
      const user = await this.prisma.user.findFirst({
        where: { telegramChatId: input.chatId },
        select: { id: true, fullName: true },
      });
      const driver = user
        ? null
        : await this.prisma.driver.findFirst({
            where: { telegramChatId: input.chatId },
            select: { id: true, name: true },
          });
      // R5: only an AMS user's chat can belong to an announcement thread — a
      // driver-only chat has no announcements audience, so it stays General.
      let announcementId: string | null = null;
      if (user && input.replyToMessageId != null) {
        const sent = await this.prisma.announcementChatSend.findFirst({
          where: { chatId: input.chatId, messageId: BigInt(input.replyToMessageId) },
          select: { announcementId: true },
        });
        announcementId = sent?.announcementId ?? null;
      }
      const row = await this.prisma.telegramInboundMessage.create({
        data: {
          chatId: input.chatId,
          telegramMessageId: input.messageId != null ? BigInt(input.messageId) : null,
          replyToMessageId: input.replyToMessageId != null ? BigInt(input.replyToMessageId) : null,
          mediaGroupId: input.mediaGroupId ?? null,
          userId: user?.id ?? null,
          driverId: driver?.id ?? null,
          // unbound chats keep whatever Telegram gave us, so the tab can at least
          // show who wrote ("Not linked") instead of an empty bubble
          senderName: user?.fullName ?? driver?.name ?? input.senderName ?? null,
          kind,
          text: input.text ? maskInboundText(input.text) : null,
          photoFileId: input.photo?.fileId ?? null,
          photoWidth: input.photo?.width ?? null,
          photoHeight: input.photo?.height ?? null,
          documentName: input.documentName ?? null,
          announcementId,
          handledBy: announcementId ? 'ANNOUNCEMENT_REPLY' : 'GENERAL',
          state: 'NEW',
        },
        select: { id: true, announcementId: true },
      });
      // a signal only — the tab refetches through the normal API
      this.events?.publish('message.new');
      return row;
    } catch (e) {
      // (chatId, telegramMessageId) is unique: Telegram re-delivering an update
      // after a crash must not duplicate the bubble. Answer with the row we
      // already have, so a re-delivered card reply still counts as one (R1).
      if ((e as { code?: string }).code === 'P2002' && input.messageId != null) {
        const existing = await this.prisma.telegramInboundMessage
          .findFirst({
            where: { chatId: input.chatId, telegramMessageId: BigInt(input.messageId) },
            select: { id: true, announcementId: true },
          })
          .catch(() => null);
        return existing ?? null;
      }
      console.warn(`[announcements] inbound capture failed for chat ${input.chatId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Label the flow that consumed a captured message (plan §6 / R3). */
  async markHandled(id: string | null | undefined, handledBy: InboundHandledBy) {
    if (!id) return;
    try {
      await this.prisma.telegramInboundMessage.updateMany({
        // never rewrite an explicit announcement reply — R1 decides that once
        where: { id, handledBy: { not: 'ANNOUNCEMENT_REPLY' } },
        data: { handledBy },
      });
    } catch (e) {
      console.warn(`[announcements] could not label inbound message ${id}: ${(e as Error).message}`);
    }
  }

  // ---------- admin views ----------

  /** Admin list — pinned first, then newest; each row carries audience-size + department member counts. */
  async listAll() {
    const rows = await this.prisma.announcement.findMany({
      orderBy: [{ pinnedAt: 'desc' }, { createdAt: 'desc' }],
      include: { targets: true, createdBy: { select: { fullName: true } }, _count: { select: { reads: true } } },
    });
    // acked count per row in ONE query — the admin list shows "Acked 31/128" (F2)
    const ids = rows.map((r) => r.id);
    const ackGroups = ids.length
      ? await this.prisma.announcementRead.groupBy({
          by: ['announcementId'],
          where: { announcementId: { in: ids }, ackAt: { not: null } },
          _count: { _all: true },
        })
      : [];
    const ackMap = new Map(ackGroups.map((g) => [g.announcementId, g._count._all]));
    const deptCounts = await this.prisma.$queryRaw<{ departmentId: string; memberCount: number }[]>`
      SELECT "departmentId", "memberCount" FROM "department_member_counts"`;
    const countMap = new Map(deptCounts.map((d) => [d.departmentId, d.memberCount]));
    const enriched = await Promise.all(rows.map(async (a) => {
      const audience = await this.audienceIds(a.id);
      return {
        ...a,
        audienceCount: audience.length,
        ackCount: ackMap.get(a.id) ?? 0,
        targetsWithCounts: a.targets.map((t) => ({
          ...t,
          memberCount: t.targetType === 'DEPARTMENT' && t.targetId ? (countMap.get(t.targetId) ?? null) : null,
        })),
      };
    }));
    return enriched;
  }

  /** Target/read/unread for the tracking view (IMPORTANT+ only, Plan §18). */
  async readStats(id: string) {
    const a = await this.prisma.announcement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Announcement not found');
    const audience = await this.audienceIds(id);
    const reads = await this.prisma.announcementRead.findMany({ where: { announcementId: id } });
    const ackedSet = new Set(reads.filter((r) => r.ackAt).map((r) => r.userId));
    const readSet = new Set(reads.map((r) => r.userId));

    // per-department breakdown (users without a department ride under "—")
    const members = await this.prisma.user.findMany({
      where: { id: { in: audience }, status: 'ACTIVE' },
      select: {
        id: true,
        fullName: true,
        username: true,
        employee: { select: { department: { select: { id: true, name: true } } } },
      },
    });
    const byDept = new Map<string, { departmentId: string | null; name: string; target: number; read: number; acked: number }>();
    for (const m of members) {
      const key = m.employee?.department?.id ?? 'none';
      if (!byDept.has(key)) {
        byDept.set(key, {
          departmentId: m.employee?.department?.id ?? null,
          name: m.employee?.department?.name ?? 'No department',
          target: 0, read: 0, acked: 0,
        });
      }
      const row = byDept.get(key)!;
      row.target += 1;
      if (readSet.has(m.id)) row.read += 1;
      if (ackedSet.has(m.id)) row.acked += 1;
    }

    return {
      target: audience.length,
      read: audience.filter((u) => readSet.has(u)).length,
      unread: audience.filter((u) => !readSet.has(u)).length,
      acked: audience.filter((u) => ackedSet.has(u)).length,
      requiresAck: a.requiresAck,
      departments: [...byDept.values()].sort((x, y) => y.target - x.target),
      readRows: reads.map((r) => ({ userId: r.userId, readAt: r.readAt, ackAt: r.ackAt })),
      // the chase list (F3): every target with their own read/ack timestamps,
      // including the ones who never opened it — those are the ones to chase
      people: members
        .map((m) => {
          const r = reads.find((x) => x.userId === m.id);
          return {
            userId: m.id,
            name: m.fullName,
            username: m.username,
            department: m.employee?.department?.name ?? null,
            readAt: r?.readAt ?? null,
            ackAt: r?.ackAt ?? null,
          };
        })
        .sort(
          (x, y) =>
            // unacked first (the chase list), then department (no department last),
            // then name — so "who still owes me" is always at the top
            Number(!!x.ackAt) - Number(!!y.ackAt) ||
            (x.department ?? '\uffff').localeCompare(y.department ?? '\uffff') ||
            x.name.localeCompare(y.name),
        ),
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
        { pinnedAt: 'desc' },
        { publishAt: 'desc' },
      ],
      include: {
        targets: true,
        reads: { where: { userId: actor.userId }, select: { readAt: true, ackAt: true } },
        createdBy: { select: { fullName: true } },
        // first photos so list cards can show thumbnails without a second round-trip
        attachments: { orderBy: { createdAt: 'asc' }, take: 4, select: { id: true, filename: true, mimeType: true, size: true } },
      },
      take: 50,
    });
    const mine = (rows as unknown as Array<Prisma.AnnouncementGetPayload<{ include: { targets: true; reads: { where: { userId: string }; select: { readAt: true; ackAt: true } }; createdBy: { select: { fullName: true } }; attachments: { select: { id: true; filename: true; mimeType: true; size: true } } } }>>).map((a) => ({
      id: a.id, code: a.code, title: a.title, content: a.content, category: a.category,
      priority: a.priority, publishAt: a.publishAt, startAt: a.startAt, endAt: a.endAt,
      requiresAck: a.requiresAck, createdBy: a.createdBy.fullName,
      // pinnedAt travels with the row so the UI can keep the pin groups it renders
      pinnedAt: a.pinnedAt,
      read: a.reads.length > 0, acked: a.reads[0]?.ackAt ?? null,
      photos: a.attachments.filter((f) => f.mimeType.startsWith('image/')),
    }));

    // F8 — inside a pin group, a notice still waiting for acknowledgement must not
    // be buried under a newer normal one the reader has already opened:
    // needs ack → unread → read, newest first within each rank.
    const rank = (a: (typeof mine)[number]) => (a.requiresAck && !a.acked ? 0 : a.read ? 2 : 1);
    const at = (s: string | Date | null) => (s ? new Date(s).getTime() : 0);
    return mine.sort((x, y) => {
      const px = x.pinnedAt ? 1 : 0;
      const py = y.pinnedAt ? 1 : 0;
      if (px !== py) return py - px;
      if (px && py) {
        const pin = at(y.pinnedAt) - at(x.pinnedAt);
        if (pin) return pin;
      }
      const rx = rank(x);
      const ry = rank(y);
      if (rx !== ry) return rx - ry;
      return at(y.publishAt) - at(x.publishAt);
    });
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

  /**
   * The priority of a published notice went up (F5). Send the ack prompt once
   * more — only to the people who still owe an acknowledgement, and without the
   * photo album they have already seen.
   */
  private async reNotifyPriorityRaise(
    a: { id: string; code: string; title: string; content: string; priority: string; requiresAck: boolean },
    oldPriority: string,
    actor: Actor,
  ) {
    const audience = [...new Set(await this.audienceIds(a.id))];
    const acked = new Set(
      (await this.prisma.announcementRead.findMany({
        where: { announcementId: a.id, ackAt: { not: null } },
        select: { userId: true },
      })).map((r) => r.userId),
    );
    const pending = audience.filter((id) => !acked.has(id));
    // everyone already acked — there is nobody left to chase
    if (pending.length === 0) return;
    const body = htmlToText(a.content).slice(0, 300) || a.title;
    await this.notifications.notifyMany(pending, {
      type: 'ANNOUNCEMENT',
      title: `🔺 Priority raised to ${a.priority} — ${a.title}`,
      body,
      link: '/announcements',
      // the card below is the Telegram message (F9)
      skipTelegram: true,
    });
    await this.sendPhotosToAudience(a.id, pending, a, body, { album: false });
    await this.audit.log({
      userId: actor.userId, username: actor.username,
      action: 'ANNOUNCEMENT_RENOTIFIED', module: 'ANNOUNCEMENT', recordId: a.id,
      oldValue: { priority: oldPriority },
      newValue: { priority: a.priority, renotified: pending.length, alreadyAcked: acked.size },
    });
  }

  /**
   * Daily escalation digest (F7): an IMPORTANT/URGENT notice that nobody has
   * acknowledged 24 h after publishing is not "sent", it is stuck. Send the
   * creator and everyone holding `announcements.manage` one digest per notice
   * per day that names how many people still have not acked.
   *
   * Throttling rides on `Notification.dedupeKey` (unique), so a restart, a
   * second instance or an overlapping tick cannot send the same day twice.
   */
  @Cron('0 0 8 * * *')
  async unackedDigestCron() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.prisma.announcement.findMany({
      where: {
        status: 'PUBLISHED',
        requiresAck: true,
        priority: { in: ['IMPORTANT', 'URGENT', 'EMERGENCY'] },
        publishAt: { lte: cutoff },
      },
      select: { id: true, code: true, title: true, priority: true, createdById: true },
    });
    if (rows.length === 0) return;

    // creator + every active holder of announcements.manage (plan §13.1 D10)
    const managers = await this.prisma.user
      .findMany({
        where: {
          status: 'ACTIVE',
          userRoles: {
            some: { role: { permissions: { some: { permission: { code: 'announcements.manage' } } } } },
          },
        },
        select: { id: true },
      })
      .catch(() => [] as { id: string }[]);
    const day = new Date().toISOString().slice(0, 10);
    let sent = 0;

    for (const a of rows) {
      const audience = [...new Set(await this.audienceIds(a.id))];
      if (audience.length === 0) continue;
      const acked = new Set(
        (await this.prisma.announcementRead.findMany({
          where: { announcementId: a.id, ackAt: { not: null } },
          select: { userId: true },
        })).map((r) => r.userId),
      );
      const pending = audience.filter((id) => !acked.has(id));
      if (pending.length === 0) continue;

      const names = await this.prisma.user.findMany({
        where: { id: { in: pending.slice(0, 5) } },
        select: { id: true, fullName: true },
      });
      const who = names.map((n) => n.fullName).join(', ');
      const title = `⏰ ${pending.length} still unacked — ${a.title}`;
      const body = [
        `${a.code} · ${a.priority} · published over 24 h ago`,
        `${pending.length} of ${audience.length} have not acknowledged`,
        who ? `${who}${pending.length > names.length ? ' …' : ''}` : '',
      ].filter(Boolean).join('\n');
      const recipients = [...new Set([a.createdById, ...managers.map((m) => m.id)])];

      for (const userId of recipients) {
        try {
          await this.notifications.notify({
            userId,
            type: 'ANNOUNCEMENT',
            title,
            body,
            link: `/announcements?ann=${a.id}`,
            // one digest per notice per person per day
            dedupeKey: `ann:${a.id}:digest:${day}:${userId}`,
          });
          sent += 1;
        } catch (e) {
          // P2002 = this person already got today's digest
          if ((e as { code?: string }).code !== 'P2002') {
            console.warn(`[announcements] digest failed for ${a.id} → ${userId}: ${(e as Error).message}`);
          }
        }
      }
    }
    if (sent > 0) console.log(`[announcements] unacked digest sent to ${sent} recipient(s)`);
    return sent;
  }

  /** Hourly: SCHEDULED → PUBLISHED when publishAt arrives; PUBLISHED → EXPIRED after endAt. */
  // Every minute, on the minute. This used to be '0 5 * * * *', which is not
  // "every minute" but "once an hour at :05" — so a notice scheduled for 08:01
  // went out at 09:05, and the publish time shown to the admin was a lie.
  @Cron('0 * * * * *')
  async lifecycleCron() {
    const now = new Date();
    // Scheduled → published, one row at a time, through the same delivery path
    // as the Publish button. The bulk updateMany notified nobody, so a
    // scheduled URGENT notice landed with no Telegram card and no acknowledge
    // button (plan §1 G1 / P0.5 F1).
    const due = await this.prisma.announcement.findMany({
      where: { status: 'SCHEDULED', publishAt: { lte: now } },
      select: { id: true },
    });
    let published = 0;
    for (const { id } of due) {
      try {
        // Claim the row first: a slow tick, an overlapping tick or a second
        // instance must not deliver the same announcement twice.
        const claimed = await this.prisma.announcement.updateMany({
          where: { id, status: 'SCHEDULED' },
          data: { status: 'PUBLISHED' },
        });
        if (claimed.count !== 1) continue;
        const a = await this.prisma.announcement.findUnique({ where: { id } });
        if (!a) continue;
        await this.deliverPublished(a, { username: 'scheduler', via: 'schedule' });
        published += 1;
      } catch (e) {
        // Nothing reached anyone: put it back so the next tick retries instead
        // of leaving an undelivered notice marked published.
        console.error(`[announcements] scheduled publish failed for ${id}: ${(e as Error).message}`);
        await this.prisma.announcement
          .updateMany({ where: { id, status: 'PUBLISHED' }, data: { status: 'SCHEDULED' } })
          .catch(() => undefined);
      }
    }
    const toExpire = await this.prisma.announcement.updateMany({
      where: { status: 'PUBLISHED', endAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    if (published > 0) console.log(`[announcements] published ${published} scheduled announcement(s)`);
    if (toExpire.count > 0) console.log(`[announcements] expired ${toExpire.count} announcement(s)`);
  }
}
