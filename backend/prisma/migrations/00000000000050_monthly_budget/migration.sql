-- R7 — per-account monthly budget (§9): budget amounts per Account + month;
-- PR submissions validate against the remaining amount, with real spend
-- measured from APPROVED/POSTED invoices (source-of-truth principle §23).

CREATE TABLE "monthly_budgets" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "monthly_budgets_accountId_year_month_key" ON "monthly_budgets"("accountId", "year", "month");
CREATE INDEX "monthly_budgets_year_month_idx" ON "monthly_budgets"("year", "month");

ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "monthly_budgets" ADD CONSTRAINT "monthly_budgets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
