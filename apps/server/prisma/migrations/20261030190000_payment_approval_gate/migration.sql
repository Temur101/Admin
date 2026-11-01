-- Existing pending receipts were created by the optimistic payment policy.
-- Keep their grant marker so review cannot grant the same months twice.
ALTER TABLE "PaymentReceipt" ADD COLUMN "optimisticGranted" BOOLEAN NOT NULL DEFAULT false;
UPDATE "PaymentReceipt" SET "optimisticGranted" = true WHERE "status" = 'PENDING';
