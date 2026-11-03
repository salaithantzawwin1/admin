-- Every JWT issued before a password change stops working: a stolen token must
-- not survive the remedy. NULL = the account never changed its password.
ALTER TABLE "users" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
