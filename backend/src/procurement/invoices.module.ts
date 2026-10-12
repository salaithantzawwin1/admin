import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { ProcurementModule } from './procurement.module';

/**
 * Procurement Phase 4 (design §22–25, roadmap R6): vendor invoices + the
 * three-way match. Reuses the PR module's audit chain; guards Controls 3–5.
 */
@Module({
  imports: [ProcurementModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
