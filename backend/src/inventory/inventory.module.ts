import { Module, OnModuleInit } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AuthModule } from '../auth/auth.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { WorkflowService } from '../workflow/workflow.service';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  // ScheduleModule.forRoot() lives in AppModule (single scheduler app-wide)
  imports: [AuthModule, WorkflowModule, MulterModule.register({ storage: memoryStorage() }), SuppliersModule],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule implements OnModuleInit {
  constructor(
    private inventory: InventoryService,
    private workflow: WorkflowService,
  ) {}

  /** Office supply requests auto-fulfill (stock deduction) on final approval. */
  onModuleInit() {
    this.workflow.registerFinalApproveHook('OFFICE_SUPPLY_REQUEST', (requestId, actor) =>
      this.inventory.fulfill(requestId, actor),
    );
    this.workflow.registerCancelHook('OFFICE_SUPPLY_REQUEST', (requestId, actor) =>
      this.inventory.adminCancelSupply(requestId, 'Cancelled by requester', actor),
    );
  }
}
