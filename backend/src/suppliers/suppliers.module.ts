import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

@Module({
  // NumberingService is @Global; WorkflowModule exports WorkflowService for PO submission
  imports: [AuthModule, AuditModule, WorkflowModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
