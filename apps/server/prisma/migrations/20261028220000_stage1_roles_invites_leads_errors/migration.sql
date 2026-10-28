-- CreateEnum
CREATE TYPE "BotAdminRole" AS ENUM ('OWNER', 'STAFF');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'DONE', 'REJECTED');

-- AlterTable Bot
ALTER TABLE "Bot"
  ADD COLUMN "healthStatus" VARCHAR(32) NOT NULL DEFAULT 'OK',
  ADD COLUMN "lastErrorCode" VARCHAR(64),
  ADD COLUMN "lastErrorMsg" TEXT,
  ADD COLUMN "lastErrorAt" TIMESTAMPTZ;

-- AlterTable BotUser
ALTER TABLE "BotUser"
  ADD COLUMN "role" "BotAdminRole",
  ADD COLUMN "receivesLeads" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "unreachableAt" TIMESTAMPTZ;

-- Migrate existing admins to OWNER role
UPDATE "BotUser" SET "role" = 'OWNER' WHERE "isAdmin" = true AND "role" IS NULL;

-- CreateTable AdminInvite
CREATE TABLE "AdminInvite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "botId" UUID NOT NULL,
    "role" "BotAdminRole" NOT NULL DEFAULT 'OWNER',
    "codeHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "usedAt" TIMESTAMPTZ,
    "usedByTgId" BIGINT,
    "revokedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminInvite_codeHash_key" ON "AdminInvite"("codeHash");

-- CreateIndex
CREATE INDEX "AdminInvite_botId_revokedAt_usedAt_idx" ON "AdminInvite"("botId", "revokedAt", "usedAt");

-- AddForeignKey
ALTER TABLE "AdminInvite" ADD CONSTRAINT "AdminInvite_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable Lead
ALTER TABLE "Lead"
  ADD COLUMN "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
  ADD COLUMN "assigneeTgId" BIGINT,
  ADD COLUMN "assignedAt" TIMESTAMPTZ,
  ADD COLUMN "statusChangedAt" TIMESTAMPTZ,
  ADD COLUMN "notificationRefs" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "Lead_botId_status_createdAt_idx" ON "Lead"("botId", "status", "createdAt");

-- AlterTable Booking
ALTER TABLE "Booking"
  ADD COLUMN "phoneVerified" BOOLEAN NOT NULL DEFAULT false;
