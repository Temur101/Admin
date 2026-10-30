CREATE TABLE "NotificationDelivery" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(), "botId" UUID NOT NULL,
 "eventKey" VARCHAR(255) NOT NULL, "recipientTgId" BIGINT NOT NULL, "payload" JSONB NOT NULL,
 "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
 "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "lockedUntil" TIMESTAMPTZ,
 "leaseToken" UUID, "lastError" TEXT, "deliveredAt" TIMESTAMPTZ,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "NotificationDelivery_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationDelivery_eventKey_recipientTgId_key" ON "NotificationDelivery"("eventKey", "recipientTgId");
CREATE INDEX "NotificationDelivery_status_availableAt_lockedUntil_idx" ON "NotificationDelivery"("status", "availableAt", "lockedUntil");
CREATE INDEX "NotificationDelivery_botId_status_idx" ON "NotificationDelivery"("botId", "status");
