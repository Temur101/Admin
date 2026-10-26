-- Step 1: Add endTime column to Booking if not exists
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "endTime" TIMESTAMPTZ;

-- Step 2: Backfill endTime for existing rows from slotTime + durationMin
UPDATE "Booking"
SET "endTime" = "slotTime" + ("durationMin" || ' minutes')::interval
WHERE "endTime" IS NULL;

-- Step 3: Create trigger function to ensure endTime is always populated
CREATE OR REPLACE FUNCTION set_booking_end_time()
RETURNS trigger AS $$
BEGIN
  IF NEW."endTime" IS NULL THEN
    NEW."endTime" := NEW."slotTime" + (NEW."durationMin" || ' minutes')::interval;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_end_time ON "Booking";
CREATE TRIGGER trg_booking_end_time
BEFORE INSERT OR UPDATE ON "Booking"
FOR EACH ROW EXECUTE FUNCTION set_booking_end_time();

-- Step 4: Add index for botId, staffId, status, slotTime, endTime
CREATE INDEX IF NOT EXISTS "Booking_botId_staffId_status_slotTime_endTime_idx"
ON "Booking"("botId", "staffId", "status", "slotTime", "endTime");

-- Step 5: Detect existing overlaps without deleting them automatically
DO $$
DECLARE
  overlap_record RECORD;
  found_overlap BOOLEAN := false;
BEGIN
  FOR overlap_record IN
    SELECT b1.id AS id1, b2.id AS id2, b1."botId", b1."staffId", b1."slotTime" AS s1, b1."endTime" AS e1, b2."slotTime" AS s2, b2."endTime" AS e2
    FROM "Booking" b1
    JOIN "Booking" b2 ON b1."botId" = b2."botId"
      AND b1."staffId" = b2."staffId"
      AND b1.id < b2.id
      AND b1.status IN ('PENDING', 'CONFIRMED')
      AND b2.status IN ('PENDING', 'CONFIRMED')
      AND tstzrange(b1."slotTime", b1."endTime") && tstzrange(b2."slotTime", b2."endTime")
  LOOP
    found_overlap := true;
    RAISE WARNING 'Overlapping booking found: % [% - %] overlaps % [% - %] for bot % staff %',
      overlap_record.id1, overlap_record.s1, overlap_record.e1,
      overlap_record.id2, overlap_record.s2, overlap_record.e2,
      overlap_record."botId", overlap_record."staffId";
  END LOOP;

  IF found_overlap THEN
    RAISE EXCEPTION 'Existing overlapping bookings detected! Resolve overlapping active bookings before applying booking_no_overlap_excl constraint.';
  ELSE
    CREATE EXTENSION IF NOT EXISTS btree_gist;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_no_overlap_excl') THEN
      ALTER TABLE "Booking" ADD CONSTRAINT "booking_no_overlap_excl"
      EXCLUDE USING gist (
        "botId" WITH =,
        "staffId" WITH =,
        tstzrange("slotTime", "endTime") WITH &&
      ) WHERE ("status" IN ('PENDING', 'CONFIRMED'));
    END IF;
  END IF;
END $$;
