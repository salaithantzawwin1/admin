import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** R7 — procurement reports + budget-vs-actual, all on real transaction data. */
@Module({
  imports: [BudgetModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
