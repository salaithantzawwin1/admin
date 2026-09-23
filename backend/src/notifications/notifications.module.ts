import { Global, Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

@Global()
@Module({
  imports: [TelegramModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
