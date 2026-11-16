import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

/** Subscriber inbox read API (the Messages tab on /announcements). */
@Module({
  imports: [TelegramModule],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
