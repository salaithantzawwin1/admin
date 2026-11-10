-- CreateEnum
CREATE TYPE "InboundMessageState" AS ENUM ('NEW', 'READ');

-- CreateEnum
CREATE TYPE "InboundMessageKind" AS ENUM ('TEXT', 'PHOTO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "InboundMessageHandledBy" AS ENUM ('ANNOUNCEMENT_REPLY', 'GENERAL', 'CAR_FORM', 'REJECT_REASON', 'ODOMETER', 'ETA', 'COMMAND');

-- CreateTable
CREATE TABLE "announcement_chat_sends" (
    "id" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" BIGINT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_chat_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_inbound_messages" (
    "id" UUID NOT NULL,
    "chatId" TEXT NOT NULL,
    "telegramMessageId" BIGINT,
    "replyToMessageId" BIGINT,
    "mediaGroupId" TEXT,
    "userId" UUID,
    "driverId" UUID,
    "senderName" TEXT,
    "kind" "InboundMessageKind" NOT NULL DEFAULT 'TEXT',
    "text" TEXT,
    "photoFileId" TEXT,
    "photoWidth" INTEGER,
    "photoHeight" INTEGER,
    "documentName" TEXT,
    "announcementId" UUID,
    "handledBy" "InboundMessageHandledBy" NOT NULL DEFAULT 'GENERAL',
    "state" "InboundMessageState" NOT NULL DEFAULT 'NEW',
    "readById" UUID,
    "readAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "announcement_chat_sends_chatId_messageId_key" ON "announcement_chat_sends"("chatId", "messageId");

-- CreateIndex
CREATE INDEX "announcement_chat_sends_announcementId_idx" ON "announcement_chat_sends"("announcementId");

-- CreateIndex
CREATE INDEX "announcement_chat_sends_chatId_sentAt_idx" ON "announcement_chat_sends"("chatId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_inbound_messages_chatId_telegramMessageId_key" ON "telegram_inbound_messages"("chatId", "telegramMessageId");

-- CreateIndex
CREATE INDEX "telegram_inbound_messages_announcementId_receivedAt_idx" ON "telegram_inbound_messages"("announcementId", "receivedAt");

-- CreateIndex
CREATE INDEX "telegram_inbound_messages_chatId_receivedAt_idx" ON "telegram_inbound_messages"("chatId", "receivedAt");

-- CreateIndex
CREATE INDEX "telegram_inbound_messages_state_receivedAt_idx" ON "telegram_inbound_messages"("state", "receivedAt");

-- AddForeignKey
ALTER TABLE "announcement_chat_sends" ADD CONSTRAINT "announcement_chat_sends_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_inbound_messages" ADD CONSTRAINT "telegram_inbound_messages_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
