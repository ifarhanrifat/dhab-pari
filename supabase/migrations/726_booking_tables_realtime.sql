-- Real gap found 2026-10-21: useBookingLiveStatus's Realtime subscription
-- (used by BookingQuickViewSheet so a rider's open booking status updates
-- live instead of needing a manual re-open) only fires for tables in the
-- supabase_realtime publication. Confirmed live: only portal_notifications
-- was in it — hourly_bookings/rental_bookings/equipment_bookings/
-- ride_bookings weren't, so that hook's channel silently never received
-- anything and only its poll fallback ever ran. Each table's existing
-- SELECT RLS policy (hourly_bookings_parties_read etc.) already scopes
-- who can read a row at all; adding a table to this publication doesn't
-- change that — postgres_changes still only delivers rows the
-- subscriber's own RLS would let them SELECT.
ALTER PUBLICATION supabase_realtime ADD TABLE hourly_bookings;
ALTER PUBLICATION supabase_realtime ADD TABLE rental_bookings;
ALTER PUBLICATION supabase_realtime ADD TABLE equipment_bookings;
ALTER PUBLICATION supabase_realtime ADD TABLE ride_bookings;
