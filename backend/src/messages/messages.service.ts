import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InboundMessageHandledBy, InboundMessageKind, InboundMessageState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

/** The Messages tab filters (plan §8). Unknown values are a 400, not an empty page. */
export interface MessageQuery {
  announcementId?: string;
  handledBy?: string;
  kind?: string;
  state?: string;
  /** `pending` = messages in an ack-requiring thread whose sender never acked */
  ack?: string;
  page?: string;
  pageSize?: string;
}

const HANDLED_BY = ['ANNOUNCEMENT_REPLY', 'GENERAL', 'CAR_FORM', 'REJECT_REASON', 'ODOMETER', 'ETA', 'COMMAND'] as const;
const KINDS = ['TEXT', 'PHOTO', 'DOCUMENT'] as const;
const STATES = ['NEW', 'READ'] as const;

/** `announcementId=none` selects the General bucket (rows with no announcement). */
const GENERAL = 'none';
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;

/**
 * Read side of the subscriber inbox (plan §8 / P5).
 *
 * `telegram_inbound_messages` is written by the capture path (P4) and is
 * append-only from the bot's point of view: this service only lists it and marks
 * rows read, so a message can be re-read but never silently vanish.
 */
/**
 * How long a subscriber message is kept. Photos are never downloaded (only the
 * Telegram file_id is stored), so retention is the row itself; 180 days is long
 * enough to answer "who said this, and when", short enough that the table does
 * not grow forever. `TELEGRAM_INBOUND_RETENTION_DAYS=0` turns the purge off.
 */
const RETENTION_DEFAULT_DAYS = 180;

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Daily retention purge (plan P9). Announcement replies are historical
   * evidence, so the window is generous; once a message is past it, its link to
   * a notice was already resolved and it can go.
   */
  @Cron('0 30 3 * * *')
  async retentionCron() {
    const raw = process.env.TELEGRAM_INBOUND_RETENTION_DAYS;
    const days = raw == null || raw === '' ? RETENTION_DEFAULT_DAYS : Number(raw);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const res = await this.prisma.telegramInboundMessage.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    if (res.count > 0) {
      this.logger.log(`purged ${res.count} subscriber message(s) older than ${days} day(s)`);
    }
    return res.count;
  }

  // ---------- validation ----------

  private oneOf<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T | undefined {
    if (value == null || value === '') return undefined;
    if (!(allowed as readonly string[]).includes(value)) {
      throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}`);
    }
    return value as T;
  }

  private paging(query: MessageQuery) {
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const raw = Number.parseInt(query.pageSize ?? String(PAGE_SIZE_DEFAULT), 10) || PAGE_SIZE_DEFAULT;
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, raw));
    return { page, pageSize, skip: (page - 1) * pageSize };
  }

  /** Resolve the thread filter: an announcement id, `none` (General), or everything. */
  private threadFilter(announcementId?: string): Prisma.TelegramInboundMessageWhereInput {
    if (announcementId == null || announcementId === '' || announcementId === 'all') return {};
    if (announcementId === GENERAL) return { announcementId: null };
    return { announcementId };
  }

  /**
   * Rows whose sender owes an acknowledgement (the tab's "Not acked" list).
   *
   * Ack records point at (announcement, user), so this cannot be a plain column
   * filter: we read the ack-requiring announcements and their acked senders, then
   * ask for "this announcement AND not one of those senders" per announcement.
   * Bounded by the number of ack-requiring notices, which is small by design.
   */
  private async pendingAckFilter(): Promise<Prisma.TelegramInboundMessageWhereInput> {
    const announcements = await this.prisma.announcement.findMany({
      where: { requiresAck: true },
      select: { id: true },
    });
    if (announcements.length === 0) return { id: { in: [] } }; // matches nothing
    const reads = await this.prisma.announcementRead.findMany({
      where: { announcementId: { in: announcements.map((a) => a.id) }, ackAt: { not: null } },
      select: { announcementId: true, userId: true },
    });
    const ackedBy = new Map<string, string[]>();
    for (const r of reads) {
      const list = ackedBy.get(r.announcementId);
      if (list) list.push(r.userId);
      else ackedBy.set(r.announcementId, [r.userId]);
    }
    return {
      OR: announcements.map((a) => {
        const acked = ackedBy.get(a.id);
        // a null sender can never acknowledge, so they are not a chase target
        return acked
          ? { announcementId: a.id, userId: { notIn: acked } }
          : { announcementId: a.id, userId: { not: null } };
      }),
    };
  }

  // ---------- GET /messages/threads ----------

  /**
   * One row per announcement that has at least one reply, plus the General
   * bucket (everything not linked to an announcement). Threads are ordered by
   * their newest message, so a fresh reply lifts its notice to the top.
   */
  async threads() {
    const groups = await this.prisma.telegramInboundMessage.groupBy({
      by: ['announcementId', 'state'],
      _count: { _all: true },
      _max: { receivedAt: true },
    });

    const perThread = new Map<string, { total: number; unread: number; lastAt: Date | null }>();
    const keyOf = (id: string | null) => id ?? GENERAL;
    for (const g of groups) {
      const key = keyOf(g.announcementId);
      const agg = perThread.get(key) ?? { total: 0, unread: 0, lastAt: null };
      agg.total += g._count._all;
      if (g.state === 'NEW') agg.unread += g._count._all;
      const last = g._max.receivedAt;
      if (last && (!agg.lastAt || last > agg.lastAt)) agg.lastAt = last;
      perThread.set(key, agg);
    }

    const ids = [...perThread.keys()].filter((k) => k !== GENERAL);
    const announcements = ids.length
      ? await this.prisma.announcement.findMany({
          where: { id: { in: ids } },
          select: { id: true, code: true, title: true, publishAt: true, requiresAck: true, status: true },
        })
      : [];
    const byId = new Map(announcements.map((a) => [a.id, a]));

    const threads = ids
      .map((id) => {
        const a = byId.get(id);
        const agg = perThread.get(id)!;
        return {
          announcementId: id,
          code: a?.code ?? null,
          title: a?.title ?? 'Deleted announcement',
          status: a?.status ?? null,
          publishAt: a?.publishAt ?? null,
          requiresAck: a?.requiresAck ?? false,
          total: agg.total,
          unread: agg.unread,
          lastAt: agg.lastAt,
        };
      })
      // newest reply first; a thread with no timestamp can only be empty/lost
      .sort((x, y) => (y.lastAt?.getTime() ?? 0) - (x.lastAt?.getTime() ?? 0));

    const generalAgg = perThread.get(GENERAL);
    return {
      general: {
        total: generalAgg?.total ?? 0,
        unread: generalAgg?.unread ?? 0,
        lastAt: generalAgg?.lastAt ?? null,
      },
      threads,
    };
  }

  // ---------- GET /messages ----------

  /**
   * Paged messages, newest first. Sender identity is joined here (the table only
   * stores ids) and `ackAt` comes from the announcement read/ack record of that
   * same sender, so the tab can show "answered + acknowledged" on one row.
   */
  async list(query: MessageQuery) {
    const kind = this.oneOf<InboundMessageKind>(query.kind, KINDS, 'kind');
    const state = this.oneOf<InboundMessageState>(query.state, STATES, 'state');
    const ack = this.oneOf(query.ack, ['pending'] as const, 'ack');
    const { page, pageSize, skip } = this.paging(query);

    // `IN_PROGRESS` is the tab's word for "a bot flow already took this one"
    // (odometer, reject reason, ETA, car form, command) — one alias instead of
    // five handledBy values in the URL.
    const handledWhere: Prisma.TelegramInboundMessageWhereInput =
      query.handledBy === 'IN_PROGRESS'
        ? { handledBy: { notIn: ['GENERAL', 'ANNOUNCEMENT_REPLY'] } }
        : (() => {
            const h = this.oneOf<InboundMessageHandledBy>(query.handledBy, HANDLED_BY, 'handledBy');
            return h ? { handledBy: h } : {};
          })();

    const where: Prisma.TelegramInboundMessageWhereInput = {
      ...this.threadFilter(query.announcementId),
      ...handledWhere,
      ...(kind ? { kind } : {}),
      ...(state ? { state } : {}),
      ...(ack === 'pending' ? { AND: [await this.pendingAckFilter()] } : {}),
    };

    const [total, unread, rows] = await Promise.all([
      this.prisma.telegramInboundMessage.count({ where }),
      this.prisma.telegramInboundMessage.count({ where: { ...where, state: 'NEW' } }),
      this.prisma.telegramInboundMessage.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { telegramMessageId: 'desc' }],
        skip,
        take: pageSize,
        select: {
          id: true,
          chatId: true,
          telegramMessageId: true,
          replyToMessageId: true,
          mediaGroupId: true,
          userId: true,
          driverId: true,
          senderName: true,
          kind: true,
          text: true,
          photoFileId: true,
          photoWidth: true,
          photoHeight: true,
          documentName: true,
          announcementId: true,
          handledBy: true,
          state: true,
          readAt: true,
          receivedAt: true,
        },
      }),
    ]);

    const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true, employee: { select: { department: { select: { name: true } } } } },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    // one query for the ack state of every (announcement, sender) pair on the page
    const acks = new Map<string, Date | null>();
    const pairs = rows.filter((r) => r.announcementId && r.userId);
    if (pairs.length) {
      const reads = await this.prisma.announcementRead.findMany({
        where: {
          OR: pairs.map((r) => ({ announcementId: r.announcementId!, userId: r.userId! })),
        },
        select: { announcementId: true, userId: true, ackAt: true },
      });
      for (const r of reads) acks.set(`${r.announcementId}:${r.userId}`, r.ackAt);
    }

    const items = rows.map((r) => {
      const u = r.userId ? userById.get(r.userId) : undefined;
      return {
        id: r.id,
        chatId: r.chatId,
        messageId: r.telegramMessageId != null ? r.telegramMessageId.toString() : null,
        replyToMessageId: r.replyToMessageId != null ? r.replyToMessageId.toString() : null,
        mediaGroupId: r.mediaGroupId,
        sender: {
          userId: r.userId,
          driverId: r.driverId,
          name: u?.fullName ?? r.senderName ?? null,
          department: u?.employee?.department?.name ?? null,
          linked: !!(r.userId || r.driverId),
        },
        kind: r.kind,
        text: r.text,
        photo: r.photoFileId
          ? { fileId: r.photoFileId, width: r.photoWidth, height: r.photoHeight }
          : null,
        documentName: r.documentName,
        announcementId: r.announcementId,
        handledBy: r.handledBy,
        state: r.state,
        readAt: r.readAt,
        receivedAt: r.receivedAt,
        ackAt: r.announcementId && r.userId ? (acks.get(`${r.announcementId}:${r.userId}`) ?? null) : null,
      };
    });

    return { items, total, unread, page, pageSize };
  }

  // ---------- GET /messages/unread-count ----------

  /** Badge count for the tab (one number, no page payload). */
  async unreadCount() {
    const count = await this.prisma.telegramInboundMessage.count({ where: { state: 'NEW' } });
    return { count };
  }

  // ---------- POST /messages/:id/read ----------

  async markRead(id: string, userId: string) {
    const row = await this.prisma.telegramInboundMessage.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new NotFoundException('Message not found');
    await this.prisma.telegramInboundMessage.update({
      where: { id },
      data: { state: 'READ', readAt: new Date(), readById: userId },
    });
    return { ok: true, id };
  }

  // ---------- POST /messages/read-all ----------

  /**
   * Clear a thread (`announcementId=<id>`), just General (`none`), or everything
   * (no param / `all`). Only NEW rows are touched, so the who/when of an earlier
   * read is never overwritten.
   */
  async readAll(announcementId: string | undefined, userId: string) {
    const where: Prisma.TelegramInboundMessageWhereInput = {
      ...this.threadFilter(announcementId),
      state: 'NEW',
    };
    const { count } = await this.prisma.telegramInboundMessage.updateMany({
      where,
      data: { state: 'READ', readAt: new Date(), readById: userId },
    });
    return { updated: count };
  }
}
