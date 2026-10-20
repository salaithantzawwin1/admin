import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * GLG Procurement ERP W1 — vendor payments (design §26, Plan §9).
 * Numbering + audit + Prisma modules are @Global() — services inject directly.
 */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
