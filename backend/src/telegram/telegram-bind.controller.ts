import { Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TelegramService } from './telegram.service';

/**
 * Self-service Telegram binding for system users (any authenticated user):
 * Profile → Telegram → generate code → "/start <code>" to the AMS bot.
 * Once bound, every in-app notification also mirrors to the user's chat.
 */
@ApiTags('telegram')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('telegram')
export class TelegramBindController {
  constructor(private telegram: TelegramService) {}

  /** Current user's binding state + pending bind code + bot identity. */
  @Get('me')
  async myBinding(@Req() req) {
    const binding = await this.telegram.userBinding(req.user.id);
    const bot = await this.telegram.getMe();
    return { ...binding, botUsername: bot.username ?? null, configured: bot.configured };
  }

  /** Generate a bind code — the user then sends "/start <code>" to the bot. */
  @Post('bind-code')
  async newBindCode(@Req() req) {
    const code = await this.telegram.regenerateUserBindCode(req.user.id);
    const bot = await this.telegram.getMe();
    return { code, botUsername: bot.username ?? null };
  }

  /** Unbind this user's Telegram chat. */
  @Delete('bind')
  async unbind(@Req() req) {
    await this.telegram.unbindUser(req.user.id);
    return { ok: true };
  }
}
