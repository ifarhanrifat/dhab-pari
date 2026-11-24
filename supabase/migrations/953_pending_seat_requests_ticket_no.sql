-- Migration 953: real ask, live, 2026-11-24 — "where is the ticket
-- number?" on the driver's own pending-requests approval queue
-- (route_pending_seat_requests, final body: 831). ride_bookings.ticket_no
-- has existed since 948 and is assigned at booking time (before the
-- driver ever confirms), so it's already there to show — this RPC just
-- never selected it. True-replacing to add it, nothing else changed.

CREATE OR REPLACE FUNCTION route_pending_seat_requests(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', rb.id, 'ticket_no', rb.ticket_no, 'name', pu.full_name, 'seats', rb.seats, 'travel_date', rb.travel_date, 'direction', rb.direction,
      'total_amount_pkr', rb.total_amount_pkr, 'announced_method', rb.announced_method, 'announced_proof_url', rb.announced_proof_url
    ) ORDER BY rb.travel_date, rb.created_at), '[]'::jsonb)
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.route_id = p_route_id AND rb.status = 'announced' AND rb.seat_accepted_at IS NULL
      AND rb.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_pending_seat_requests(uuid) TO authenticated;
