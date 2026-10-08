-- Phase 2 (R3): amount-based approval routing (Procurement design §8).
-- A module may now define several active workflows, each covering an amount
-- band [minAmount, maxAmount] (inclusive, both optional); the workflow with
-- neither bound is the module default used when no band matches.

-- Drop the one-workflow-per-module uniqueness; keep a lookup index instead.
DROP INDEX IF EXISTS "approval_workflows_module_key";
CREATE INDEX IF NOT EXISTS "approval_workflows_module_active_idx" ON "approval_workflows"("module", "active");

ALTER TABLE "approval_workflows" ADD COLUMN "minAmount" DECIMAL(12,2);
ALTER TABLE "approval_workflows" ADD COLUMN "maxAmount" DECIMAL(12,2);
