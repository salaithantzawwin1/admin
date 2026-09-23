import { Module, OnModuleInit } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { TelegramService } from '../telegram/telegram.service';
import { AnnouncementsController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';

/**
 * Announcements + Telegram integration: the ack button on IMPORTANT+ notice
 * cards needs the audience check from AnnouncementsService, so the service is
 * handed to TelegramService at bootstrap (announcementsRef).
 */
@Module({
  imports: [TelegramModule],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule implements OnModuleInit {
  constructor(
    private readonly announcements: AnnouncementsService,
    private readonly telegram: TelegramService,
  ) {}

  onModuleInit() {
    this.telegram.announcementsRef = this.announcements;
  }
}
