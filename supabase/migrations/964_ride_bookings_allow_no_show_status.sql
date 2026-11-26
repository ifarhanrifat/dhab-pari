-- Migration 964: real bug caught live immediately after 962/963 —
-- ride_bookings_status_check (436) only ever allowed
-- ('announced', 'confirmed', 'rejected', 'cancelled'). This is the
-- real reason the original mark_rider_no_show (828) overloaded
-- status='cancelled' with a text reason instead of a dedicated value
-- in the first place — 'no_show' was never a legal status at all.
-- Confirmed live: setting status='no_show' failed with a 23514 check-
-- constraint violation. Widened to match manual_ride_bookings' own
-- constraint (924), which already allows 'no_show'.
ALTER TABLE ride_bookings DROP CONSTRAINT IF EXISTS ride_bookings_status_check;
ALTER TABLE ride_bookings ADD CONSTRAINT ride_bookings_status_check CHECK (status IN ('announced', 'confirmed', 'rejected', 'cancelled', 'no_show'));
