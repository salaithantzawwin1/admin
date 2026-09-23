import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { DelegationsService } from './delegations.service';

export { WorkflowService } from './workflow.service';

@Module({
  controllers: [WorkflowController],
  providers: [WorkflowService, DelegationsService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
