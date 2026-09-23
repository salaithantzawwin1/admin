import { Module } from '@nestjs/common';
import { TelegramBindController } from './telegram-bind.controller';
import { TelegramService } from './telegram.service';

/**
 * Telegram integration: driver assignment notifications + user bind (all
 * in-app notifications mirror to Telegram) + self-service binding endpoints.
 * The Telegram-side approve/assign handlers live in CarsModule (they need
 * CarsService) and wire themselves into this module's poll loop at bootstrap.
 * Config lives in system_settings (`telegram.bot_token`, `telegram.enabled`) —
 * edited from Settings → Telegram. AuditService/PrismaService come from @Global modules.
 */
@Module({
  controllers: [TelegramBindController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
