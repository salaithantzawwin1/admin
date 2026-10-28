import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { WorkflowAdminService } from './workflow-admin.service';
import { DelegationsService } from './delegations.service';

export { WorkflowService } from './workflow.service';

@Module({
  // AuthModule exports PermissionsService — the /requests list scope guard injects it
  // EventsModule exports the SSE broker — status transitions push live to open tabs
  imports: [AuthModule, EventsModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowAdminService, DelegationsService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
