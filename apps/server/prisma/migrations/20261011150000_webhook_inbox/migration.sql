-- CreateEnum
CREATE TYPE "InboxStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "WebhookInbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "botId" UUID NOT NULL,
    "updateId" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "InboxStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lockedUntil" TIMESTAMPTZ,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ,

    CONSTRAINT "WebhookInbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookInbox_botId_updateId_key" ON "WebhookInbox"("botId", "updateId");

-- CreateIndex
CREATE INDEX "WebhookInbox_status_lockedUntil_idx" ON "WebhookInbox"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "WebhookInbox_botId_status_idx" ON "WebhookInbox"("botId", "status");

-- AddForeignKey
ALTER TABLE "WebhookInbox" ADD CONSTRAINT "WebhookInbox_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
