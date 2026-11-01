-- QuickBook: delayed min-lead / service price changes and the agreed price stored on bookings.

CREATE TYPE "SettingChangeKind" AS ENUM ('MIN_LEAD', 'SERVICE_PRICE');
CREATE TYPE "SettingChangeStatus" AS ENUM ('PENDING', 'APPLIED', 'REPLACED', 'CANCELLED');

-- Legacy bookings keep NULL: their historical price is not reliably known.
ALTER TABLE "Booking" ADD COLUMN "priceUzs" INTEGER;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_priceUzs_nonneg" CHECK ("priceUzs" IS NULL OR "priceUzs" >= 0);

CREATE TABLE "BotSettingChange" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "botId" UUID NOT NULL,
  "kind" "SettingChangeKind" NOT NULL,
  "targetId" VARCHAR(64) NOT NULL DEFAULT '',
  "oldValue" INTEGER,
  "newValue" INTEGER NOT NULL,
  "effectiveAt" TIMESTAMPTZ NOT NULL,
  "status" "SettingChangeStatus" NOT NULL DEFAULT 'PENDING',
  "createdByTgId" BIGINT,
  "createdByAdminId" UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ,
  "resolvedByTgId" BIGINT,
  "resolvedByAdminId" UUID,
  "resolution" VARCHAR(255),
  CONSTRAINT "BotSettingChange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BotSettingChange_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BotSettingChange_newValue_nonneg" CHECK ("newValue" >= 0),
  CONSTRAINT "BotSettingChange_min_lead_floor" CHECK ("kind" <> 'MIN_LEAD' OR "newValue" >= 60)
);

CREATE INDEX "BotSettingChange_botId_status_effectiveAt_idx"
  ON "BotSettingChange"("botId", "status", "effectiveAt");

-- One live pending change per setting; replacing marks the old row REPLACED first.
CREATE UNIQUE INDEX "bot_setting_change_pending_uq"
  ON "BotSettingChange"("botId", "kind", "targetId")
  WHERE "status" = 'PENDING';
