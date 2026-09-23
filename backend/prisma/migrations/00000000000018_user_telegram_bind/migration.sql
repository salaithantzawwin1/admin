-- Telegram ↔ System User binding: any AMS user can link their Telegram chat
-- (bind code from Profile → in-app notifications mirror to Telegram).
-- Driver: remember the Telegram @username shown at bind time.

ALTER TABLE "users" ADD COLUMN "telegramChatId" TEXT;
ALTER TABLE "users" ADD COLUMN "telegramBindCode" TEXT;
ALTER TABLE "users" ADD COLUMN "telegramUsername" TEXT;
CREATE UNIQUE INDEX "users_telegramChatId_key" ON "users"("telegramChatId");
CREATE UNIQUE INDEX "users_telegramBindCode_key" ON "users"("telegramBindCode");

ALTER TABLE "drivers" ADD COLUMN "telegramUsername" TEXT;
