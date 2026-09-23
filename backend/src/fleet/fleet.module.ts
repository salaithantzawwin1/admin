import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';

@Module({
  imports: [TelegramModule, NotificationsModule],
  controllers: [FleetController],
  providers: [FleetService],
})
export class FleetModule {}
