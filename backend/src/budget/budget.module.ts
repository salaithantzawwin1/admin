import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';

export { BudgetService } from './budget.service';

/**
 * R7 (§9) — per-account monthly budget + the PR-submit validation hook.
 * Kept dependency-free (PrismaModule only) so the WorkflowModule can import it
 * without cycles.
 */
@Module({
  controllers: [BudgetController],
  providers: [BudgetService],
  exports: [BudgetService],
})
export class BudgetModule {}
