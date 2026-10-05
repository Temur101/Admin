-- CreateEnum
CREATE TYPE "BotType" AS ENUM ('LEADCATCH', 'QUICKBOOK');

-- CreateEnum
CREATE TYPE "SubStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'GRACE_PERIOD', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ReceiptKind" AS ENUM ('PHOTO', 'TEXT');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "Lang" AS ENUM ('RU', 'UZ');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL,
    "clientName" VARCHAR(255) NOT NULL,
    "contactPhone" VARCHAR(50) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "botType" "BotType" NOT NULL,
    "botTokenEnc" TEXT NOT NULL,
    "botTokenHash" VARCHAR(64) NOT NULL,
    "webhookSecret" VARCHAR(64) NOT NULL,
    "botUsername" VARCHAR(100),
    "adminInviteCode" VARCHAR(32) NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "status" "SubStatus" NOT NULL DEFAULT 'TRIAL',
    "trialEndsAt" TIMESTAMPTZ NOT NULL,
    "paidUntil" TIMESTAMPTZ,
    "failedReceiptAttempts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotUser" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "tgId" BIGINT NOT NULL,
    "firstName" VARCHAR(255),
    "username" VARCHAR(100),
    "lang" "Lang",
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReceipt" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "submittedByTgId" BIGINT NOT NULL,
    "kind" "ReceiptKind" NOT NULL,
    "imagePath" VARCHAR(500),
    "telegramFileId" VARCHAR(255),
    "textNote" TEXT,
    "months" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "prevPaidUntil" TIMESTAMPTZ,
    "prevStatus" "SubStatus" NOT NULL,
    "grantedUntil" TIMESTAMPTZ NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMPTZ,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "customerTgId" BIGINT NOT NULL,
    "customerName" VARCHAR(255),
    "customerUsername" VARCHAR(100),
    "phoneRaw" VARCHAR(50) NOT NULL,
    "answers" JSONB NOT NULL,
    "isMasked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "customerTgId" BIGINT NOT NULL,
    "customerName" VARCHAR(255),
    "customerPhone" VARCHAR(50) NOT NULL,
    "serviceId" VARCHAR(64) NOT NULL,
    "serviceName" VARCHAR(255) NOT NULL,
    "staffId" VARCHAR(64) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "slotTime" TIMESTAMPTZ NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "reminderSent" BOOLEAN NOT NULL DEFAULT false,
    "isMasked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admin" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "paymentDetails" TEXT NOT NULL,
    "tariffs" JSONB NOT NULL,
    "supportContact" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bot_botTokenHash_key" ON "Bot"("botTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Bot_adminInviteCode_key" ON "Bot"("adminInviteCode");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_botId_key" ON "Subscription"("botId");

-- CreateIndex
CREATE INDEX "BotUser_botId_isAdmin_idx" ON "BotUser"("botId", "isAdmin");

-- CreateIndex
CREATE UNIQUE INDEX "BotUser_botId_tgId_key" ON "BotUser"("botId", "tgId");

-- CreateIndex
CREATE INDEX "PaymentReceipt_status_createdAt_idx" ON "PaymentReceipt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_botId_createdAt_idx" ON "Lead"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_botId_slotTime_idx" ON "Booking"("botId", "slotTime");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_email_key" ON "Admin"("email");

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotUser" ADD CONSTRAINT "BotUser_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index for double booking prevention
CREATE UNIQUE INDEX "booking_slot_active_uq" ON "Booking"("botId", "staffId", "slotTime")
WHERE "status" IN ('PENDING', 'CONFIRMED');
