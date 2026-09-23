import { Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { WorkflowModule, WorkflowService } from '../workflow/workflow.module';
import { CarsController } from './cars.controller';
import { CarsService } from './cars.service';
import { TripRemindersService } from './trip-reminders.service';
import { TelegramCarActionsService } from './telegram-car-actions.service';

export { CarsService } from './cars.service';

@Module({
  imports: [AuthModule, TelegramModule, WorkflowModule],
  controllers: [CarsController],
  providers: [CarsService, TripRemindersService, TelegramCarActionsService],
  exports: [CarsService],
})
export class CarsModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private cars: CarsService,
    private workflow: WorkflowService,
    private tgActions: TelegramCarActionsService,
  ) {}

  /** Requester-initiated cancel of an approved car request → module cleanup + notifications. */
  onModuleInit() {
    this.workflow.registerCancelHook('CAR_REQUEST', (requestId, actor) =>
      this.cars.adminCancelApproved(requestId, 'Cancelled by requester', actor),
    );
  }

  /** Telegram approve/assign surface — wires into the Telegram poll loop. */
  onApplicationBootstrap() {
    this.tgActions.wire();
  }
}
