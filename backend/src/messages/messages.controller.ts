import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { TelegramService } from '../telegram/telegram.service';
import { MessageQuery, MessagesService } from './messages.service';

/**
 * The Messages tab's read API (plan §7–§8 / P5).
 *
 * `messages.read` is independent of `announcements.manage`: whoever may read the
 * inbox does not need to be able to publish, and an announcement manager without
 * the code gets a 403 here (the guard is class-level, so a future route cannot be
 * added without it). Nothing in this controller writes a message — only read
 * flags — so there is no cross-user data to scope: every caller with the code
 * sees the same inbox, like the audit log.
 */
@ApiTags('messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@RequirePermissions(PERMISSIONS.MESSAGES_READ)
@Controller('messages')
export class MessagesController {
  constructor(
    private messages: MessagesService,
    private telegram: TelegramService,
  ) {}

  /** Announcement threads + the direct and vehicle-trip buckets, with totals. */
  @Get('threads')
  threads() {
    return this.messages.threads();
  }

  /** Badge count (unread = state NEW). */
  @Get('unread-count')
  unreadCount() {
    return this.messages.unreadCount();
  }

  /** `announcementId=none` = General; no param = every message. */
  @Get()
  list(@Query() query: MessageQuery) {
    return this.messages.list(query);
  }

  /**
   * The photo bytes themselves.
   *
   * The inbound log stores only Telegram's file id, so the image is pulled from
   * the Bot API on demand. `JwtAuthGuard` already accepts `?token=` for this
   * exact case (an <img> cannot send an Authorization header), same as
   * /attachments/:id/download.
   */
  @Get(':id/photo')
  async photo(@Param('id') id: string, @Res() res: Response) {
    const fileId = await this.messages.photoFileFor(id);
    if (!fileId) throw new NotFoundException('This message has no photo');
    const file = await this.telegram.exportPhoto(fileId);
    if (!file) throw new NotFoundException('Telegram no longer has this photo');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(file.buffer);
  }

  @Post(':id/read')
  markRead(@Req() req, @Param('id') id: string) {
    return this.messages.markRead(id, req.user.id);
  }

  /** Answer a direct message or an announcement reply (never a trip flow). */
  @Post(':id/reply')
  @RequirePermissions(PERMISSIONS.MESSAGES_REPLY)
  reply(@Req() req, @Param('id') id: string, @Body() body: { text?: string }) {
    return this.messages.reply(id, body?.text ?? '', { userId: req.user.id, username: req.user.username });
  }

  @Post('read-all')
  readAll(@Req() req, @Query('announcementId') announcementId?: string, @Query('source') source?: string) {
    return this.messages.readAll(announcementId, req.user.id, source);
  }
}
