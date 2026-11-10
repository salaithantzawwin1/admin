import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

/** Subscriber inbox read API (the Messages tab on /announcements). */
@Module({
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
