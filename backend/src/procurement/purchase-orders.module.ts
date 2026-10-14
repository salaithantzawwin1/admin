import { Module } from '@nestjs/common';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { ProcurementModule } from './procurement.module';
import { InventoryModule } from '../inventory/inventory.module';
import { BudgetModule } from '../budget/budget.module';

/**
 * Procurement Phase 3 (design §15–20): Purchase Orders + GRN.
 * Reuses the PR module (PO creation validates the linked PR) and posts GRN
 * stock through the inventory engine. BudgetModule provides the §9 check that
 * runs when a PO line charges an account (the purchasing stage owns Account).
 */
@Module({
  imports: [ProcurementModule, InventoryModule, BudgetModule],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService],
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
