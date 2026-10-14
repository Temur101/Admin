-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "BookingSource" AS ENUM ('TELEGRAM', 'MANUAL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable Tenant
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE';

-- AlterTable Bot
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable Booking: make customerTgId nullable, add source
ALTER TABLE "Booking" ALTER COLUMN "customerTgId" DROP NOT NULL;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "source" "BookingSource" NOT NULL DEFAULT 'TELEGRAM';

-- AlterTable PlatformSettings
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "alertBotTokenEnc" TEXT;
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "alertChatId" BIGINT;
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "alertBotUsername" VARCHAR(100);
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "paymentInstructions" TEXT;
ALTER TABLE "PlatformSettings" ADD COLUMN IF NOT EXISTS "maintenanceMode" BOOLEAN NOT NULL DEFAULT false;
