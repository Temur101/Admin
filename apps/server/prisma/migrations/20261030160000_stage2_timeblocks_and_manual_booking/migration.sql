-- AlterTable Booking: add createdByTgId
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "createdByTgId" BIGINT;

-- CreateTable TimeBlock
CREATE TABLE IF NOT EXISTS "TimeBlock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "botId" UUID NOT NULL,
    "resourceId" VARCHAR(64) NOT NULL,
    "startsAt" TIMESTAMPTZ NOT NULL,
    "endsAt" TIMESTAMPTZ NOT NULL,
    "reason" VARCHAR(255),
    "createdByTgId" BIGINT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeBlock_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TimeBlock_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TimeBlock_botId_resourceId_startsAt_endsAt_idx" ON "TimeBlock"("botId", "resourceId", "startsAt", "endsAt");

-- CreateTable BotSettingsLog
CREATE TABLE IF NOT EXISTS "BotSettingsLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "botId" UUID NOT NULL,
    "changedByTgId" BIGINT,
    "changedByAdminId" UUID,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotSettingsLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BotSettingsLog_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BotSettingsLog_botId_createdAt_idx" ON "BotSettingsLog"("botId", "createdAt");
