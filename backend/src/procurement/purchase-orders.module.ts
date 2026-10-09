import { Module } from '@nestjs/common';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { ProcurementModule } from './procurement.module';
import { InventoryModule } from '../inventory/inventory.module';

/**
 * Procurement Phase 3 (design §15–20): Purchase Orders + GRN.
 * Reuses the PR module (PO creation validates the linked PR) and posts GRN
 * stock through the inventory engine.
 */
@Module({
  imports: [ProcurementModule, InventoryModule],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService],
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
