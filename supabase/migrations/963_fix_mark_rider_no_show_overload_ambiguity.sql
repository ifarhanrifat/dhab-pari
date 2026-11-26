-- Migration 963: real bug caught live immediately after 962 deployed —
-- CREATE OR REPLACE only replaces a function with the EXACT SAME
-- signature. mark_rider_no_show's original (828/898) was a single-arg
-- mark_rider_no_show(p_booking_id uuid); 962's p_reason text DEFAULT
-- NULL addition created a SECOND overload alongside it instead of
-- replacing it, so PostgREST could no longer tell which one a plain
-- {"p_booking_id": ...} call meant (confirmed live: PGRST203 "Could
-- not choose the best candidate function"). Drops the stale 1-arg
-- overload; the 2-arg one from 962 is the only one left.
DROP FUNCTION IF EXISTS mark_rider_no_show(uuid);
