-- AlterTable: Add reminder tracking fields to Booking
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "reminderAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "reminderLockedUntil" TIMESTAMPTZ;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "reminderLastError" TEXT;

-- CreateIndex: Index for finding due reminders quickly
CREATE INDEX IF NOT EXISTS "Booking_reminderSent_status_slotTime_idx" ON "Booking"("reminderSent", "status", "slotTime");
