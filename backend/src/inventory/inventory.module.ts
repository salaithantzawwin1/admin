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
    // Mirror workflow REJECTED/CANCELLED onto the supply tables — those paths
    // run BEFORE anything is issued (reject only from PENDING_APPROVAL, cancel
    // only from DRAFT/PENDING_APPROVAL/SUBMITTED), so closing the open lines is
    // always safe. Without this, rejected requests left inert PENDING/
    // OUT_OF_STOCK rows behind forever. Same transaction as the doc update.
    this.workflow.registerStatusMirror('OFFICE_SUPPLY_REQUEST', async (requestId, status, tx) => {
      if (status !== 'REJECTED' && status !== 'CANCELLED') return; // approval/return flows are owned by the fulfill path
      const supply = await tx.officeSupplyRequest.findUnique({ where: { requestId }, select: { id: true, status: true } });
      if (!supply || supply.status === 'REJECTED' || supply.status === 'FULFILLED') return; // already closed (admin-cancel) or nothing to do
      await tx.supplyRequestLine.updateMany({
        where: { supplyRequestId: supply.id, status: { in: ['PENDING', 'OUT_OF_STOCK'] } },
        data: { status: 'REJECTED' },
      });
      await tx.officeSupplyRequest.update({ where: { requestId }, data: { status: 'REJECTED' } });
    });
  }
}
