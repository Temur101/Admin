CREATE UNIQUE INDEX IF NOT EXISTS "booking_slot_active_uq" ON "Booking"("botId", "staffId", "slotTime")
WHERE "status" IN ('PENDING', 'CONFIRMED');
