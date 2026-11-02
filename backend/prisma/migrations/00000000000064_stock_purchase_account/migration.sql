-- §9/§17 — a stock purchase can now say which budget account paid for it, and
-- whether the money came out of the petty cash float.
--
-- Without accountId the purchase cannot appear in a budget line at all (stock
-- items carry no account of their own). pettyCashId marks purchases paid from
-- the float: that expense already counts, so the budget excludes these rows and
-- the same kyat is never counted twice.
ALTER TABLE "stock_transactions" ADD COLUMN "accountId" UUID;
ALTER TABLE "stock_transactions" ADD COLUMN "pettyCashId" UUID;

CREATE INDEX "stock_transactions_accountId_idx" ON "stock_transactions"("accountId");
