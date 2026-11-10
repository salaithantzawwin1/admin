import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
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
  constructor(private messages: MessagesService) {}

  /** Announcement threads + the General bucket, with total/unread/lastAt. */
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

  @Post(':id/read')
  markRead(@Req() req, @Param('id') id: string) {
    return this.messages.markRead(id, req.user.id);
  }

  @Post('read-all')
  readAll(@Req() req, @Query('announcementId') announcementId?: string) {
    return this.messages.readAll(announcementId, req.user.id);
  }
}
