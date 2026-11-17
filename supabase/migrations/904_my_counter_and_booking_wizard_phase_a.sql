-- Migration 904: Phase A of the booking-wizard rebuild (plan:
-- proud-tickling-glacier.md). Real gap — the booking officer's own
-- assigned terminal (fleet_staff.counter_id, already exists since
-- 855) was never surfaced anywhere; the booking form always defaulted
-- the counter dropdown blank instead of showing "booked at: {my own
-- terminal}" the way the reference does. New, purely additive RPC.
CREATE OR REPLACE FUNCTION my_counter() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id', c.id, 'city', c.city, 'name', c.name)
  FROM fleet_staff fs JOIN fleet_counters c ON c.id = fs.counter_id
  WHERE fs.portal_user_id = current_portal_user_id() AND fs.counter_id IS NOT NULL
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION my_counter() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_counter() TO authenticated;
