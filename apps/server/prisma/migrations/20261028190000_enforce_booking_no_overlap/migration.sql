-- Ensure all Booking rows have endTime populated before enforcing overlap constraints
UPDATE "Booking"
SET "endTime" = "slotTime" + ("durationMin" || ' minutes')::interval
WHERE "endTime" IS NULL;

-- Enforce booking_no_overlap_excl and booking_slot_active_uq on upgraded databases
-- where an earlier migration may have skipped adding the constraint.
DO $$
DECLARE
  overlap_record RECORD;
  found_overlap BOOLEAN := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_no_overlap_excl') THEN
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
    END IF;

    CREATE EXTENSION IF NOT EXISTS btree_gist;

    ALTER TABLE "Booking" ADD CONSTRAINT "booking_no_overlap_excl"
    EXCLUDE USING gist (
      "botId" WITH =,
      "staffId" WITH =,
      tstzrange("slotTime", "endTime") WITH &&
    ) WHERE ("status" IN ('PENDING', 'CONFIRMED'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "booking_slot_active_uq"
ON "Booking" ("botId", "staffId", "slotTime")
WHERE "status" IN ('PENDING', 'CONFIRMED');
