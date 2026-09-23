-- Telegram join requests: users who /start the bot land as PENDING drafts;
-- Administration approves and picks the AMS user (or driver) to bind.

CREATE TABLE "telegram_join_requests" (
    "id" UUID NOT NULL,
    "chatId" TEXT NOT NULL,
    "tgUsername" TEXT,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "boundUserId" UUID,
    "boundDriverId" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_join_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_join_requests_chatId_key" ON "telegram_join_requests"("chatId");

ALTER TYPE "NotificationType" ADD VALUE 'TELEGRAM_JOIN_REQUESTED';
