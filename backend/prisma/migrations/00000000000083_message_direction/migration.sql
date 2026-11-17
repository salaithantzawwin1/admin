-- An admin reply is stored beside the subscriber message it answers, so the
-- transcript and its grouping keep working unchanged.
CREATE TYPE "MessageDirection" AS ENUM ('IN', 'OUT');

ALTER TABLE "telegram_inbound_messages"
  ADD COLUMN "direction" "MessageDirection" NOT NULL DEFAULT 'IN';
