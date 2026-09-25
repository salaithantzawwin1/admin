import { Global, Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * Global so any feature service (cars, fleet, notifications, workflow …) can
 * inject EventsService and publish signals without import gymnastics.
 */
@Global()
@Module({
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
