import { Module, forwardRef } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { LdapService } from './ldap.service';
import { HolidaysService } from './holidays.service';
import { TelegramConfigService } from './telegram-config.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [forwardRef(() => TelegramModule)],
  providers: [LdapService, HolidaysService, TelegramConfigService],
  controllers: [SettingsController],
  exports: [LdapService, HolidaysService],
})
export class SettingsModule {}
