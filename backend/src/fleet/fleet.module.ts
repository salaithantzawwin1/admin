import { Module, forwardRef } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';

@Module({
  imports: [TelegramModule, NotificationsModule, AuthModule, forwardRef(() => SettingsModule)],
  controllers: [FleetController],
  providers: [FleetService],
})
export class FleetModule {}
