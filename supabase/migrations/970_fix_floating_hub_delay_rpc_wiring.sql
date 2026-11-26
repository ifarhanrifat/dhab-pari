-- Migration 970: real bug caught by an actual live-device test of the
-- ghost-departure feature (968) — the rider's ticket never showed the
-- "never departed" banner at all, even though the backend row existed
-- and was correct. Root cause: FloatingBookingsHub.tsx queries
-- route_day_delays directly from the browser's own authenticated
-- client (`supabase.from('route_day_delays').select(...)`), but that
-- table has zero grants to `authenticated` and zero RLS policies —
-- deliberately, per 900's own comment ("locked down... read and write
-- only through the SECURITY DEFINER RPCs below"). The select silently
-- returns nothing (no error surfaced, since the calling code never
-- checked for one), so delayByRoute was always empty in practice.
--
-- 956 already built the correct RPC for exactly this
-- (my_route_booking_delays) — for a different UI (a bookings-list
-- badge) that was never actually shipped — and I duplicated the same
-- direct-table-read mistake instead of finding and reusing it, twice
-- in one session (first for the isLive dock warning label, which
-- happened to go untested because the delay banner that WAS verified
-- live this session came from RouteGroupPanel's own RPC-backed
-- `today_delay` field, a completely different code path). Fix: widen
-- the existing RPC with the one new field the ghost-departure feature
-- needs (pre_departure), and repoint the frontend at it — no new
-- table access, no new mechanism, exactly the pattern 900 and 956
-- already established.
CREATE OR REPLACE FUNCTION my_route_booking_delays() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'route_id', rb.route_id, 'travel_date', rb.travel_date, 'direction', rb.direction,
    'delay_minutes', d.delay_minutes, 'delay_note', d.note, 'auto_detected', d.auto_detected,
    'pre_departure', d.pre_departure
  )), '[]'::jsonb)
  FROM ride_bookings rb JOIN route_day_delays d
    ON d.route_id = rb.route_id AND d.travel_date = rb.travel_date AND d.direction = rb.direction
  WHERE rb.portal_user_id = current_portal_user_id() AND rb.status IN ('announced', 'confirmed');
$$;
REVOKE ALL ON FUNCTION my_route_booking_delays() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_route_booking_delays() TO authenticated;
