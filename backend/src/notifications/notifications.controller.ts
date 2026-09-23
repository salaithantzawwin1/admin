import { Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get()
  async list(@Req() req, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('unreadOnly') unreadOnly?: string) {
    const [items, total, unread] = await this.notifications.list(
      req.user.id,
      Math.max(1, Number(page || 1)),
      Math.min(100, Number(pageSize || 20)),
      unreadOnly === 'true',
    );
    return { items, total, unread };
  }

  @Get('unread-count')
  async unreadCount(@Req() req) {
    const [, , unread] = await this.notifications.list(req.user.id, 1, 1);
    return { unread };
  }

  @Patch(':id/read')
  async markRead(@Req() req, @Param('id') id: string) {
    return this.notifications.markRead(req.user.id, id);
  }

  @Post('read-all')
  async markAllRead(@Req() req) {
    return this.notifications.markAllRead(req.user.id);
  }
}
