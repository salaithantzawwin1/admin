import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { TelegramService } from '../telegram/telegram.service';
import { EventsService } from '../events/events.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService, private telegram: TelegramService, private events: EventsService) {}

  async notify(params: {
    userId: string;
    type: NotificationType;
    title: string;
    body?: string;
    link?: string;
    requestId?: string;
  }) {
    const created = await this.prisma.notification.create({ data: params });
    // best-effort Telegram mirror — DB write stays authoritative, Telegram must never fail the flow
    this.telegram.mirrorToUser(params.userId, params.title, params.body, params.link)
      .catch((e) => this.logger.warn(`telegram mirror failed: ${(e as Error).message}`));
    // live push for open tabs — best-effort, never fails the write
    try {
      this.events.publish('notification', { userIds: [params.userId], requestId: params.requestId });
    } catch {
      /* SSE push is best-effort */
    }
    return created;
  }

  async notifyMany(userIds: string[], data: { type: NotificationType; title: string; body?: string; link?: string; requestId?: string }) {
    if (userIds.length === 0) return;
    await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, ...data })),
    });
    this.events.publish('notification', { userIds, requestId: data.requestId });
    for (const userId of userIds) {
      this.telegram.mirrorToUser(userId, data.title, data.body, data.link)
        .catch((e) => this.logger.warn(`telegram mirror failed: ${(e as Error).message}`));
    }
  }

  list(userId: string, page = 1, pageSize = 20, unreadOnly = false) {
    const where = unreadOnly ? { userId, readStatus: 'UNREAD' as const } : { userId };
    return this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readStatus: 'UNREAD' } }),
    ]);
  }

  /** Lightweight poll target for the bell badge — single COUNT query. */
  countUnread(userId: string) {
    return this.prisma.notification.count({ where: { userId, readStatus: 'UNREAD' } });
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readStatus: 'READ' },
    });
    return { success: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readStatus: 'UNREAD' },
      data: { readStatus: 'READ' },
    });
    return { success: true };
  }
}
