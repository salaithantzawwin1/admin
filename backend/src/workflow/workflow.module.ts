import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { DelegationsService } from './delegations.service';

export { WorkflowService } from './workflow.service';

@Module({
  // AuthModule exports PermissionsService — the /requests list scope guard injects it
  imports: [AuthModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, DelegationsService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
