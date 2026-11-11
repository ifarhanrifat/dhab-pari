-- Migration 845: driver route-creation redesign, piece 2 of 4. Seat-
-- number holds for van-kind (van/suzuki_ravi/suzuki_carry_dabba/bus/
-- coaster/hiace/suzuki_bolan, per 833's vehicle_kind grouping) routes
-- only — car/suv bookings keep today's plain seat-count model
-- untouched. No new "seat layout" table: the grid is derived client-
-- side from vehicles.total_seats + a fixed column count, so all that's
-- needed server-side is a hold ledger that stops two riders claiming
-- the same physical seat.
--
-- Ad-hoc (ride_bookings) and monthly (route_subscriptions) bookings
-- hold seats differently because they ARE different: an ad-hoc seat is
-- only held for one travel_date/direction, a monthly seat is held
-- every day the route runs, so the first is a child table scoped per
-- booking and the second is a column on the subscription itself.

CREATE TABLE IF NOT EXISTS ride_booking_seat_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_booking_id uuid NOT NULL REFERENCES ride_bookings(id) ON DELETE CASCADE,
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  travel_date date NOT NULL,
  direction varchar NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'return')),
  seat_number int NOT NULL CHECK (seat_number > 0),
  UNIQUE (route_id, travel_date, direction, seat_number)
);
CREATE INDEX IF NOT EXISTS ride_booking_seat_numbers_booking_idx ON ride_booking_seat_numbers(ride_booking_id);
ALTER TABLE ride_booking_seat_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ride_booking_seat_numbers_read" ON ride_booking_seat_numbers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.id = ride_booking_id AND (rb.portal_user_id = current_portal_user_id() OR is_route_owner(rb.route_id))));

-- Monthly riders hold the same seat every day the route runs, so this
-- is a persistent column, not a per-date table. The partial unique
-- index means a cancelled/rejected subscription's seat frees itself
-- automatically — no extra cleanup step needed anywhere. Deliberately
-- excludes 'waitlisted': a waitlisted applicant has no real seat yet,
-- so seat_number is left NULL for them (846) until they're promoted —
-- promote_next_waitlisted (831) does not yet assign a seat_number on
-- promotion, a known gap flagged rather than solved in this pass, same
-- as the substitute-vehicle seat-count mismatch noted in 846.
ALTER TABLE route_subscriptions ADD COLUMN IF NOT EXISTS seat_number int CHECK (seat_number > 0);
CREATE UNIQUE INDEX IF NOT EXISTS route_subscriptions_one_seat_per_route
  ON route_subscriptions(route_id, seat_number) WHERE status IN ('active', 'pending') AND seat_number IS NOT NULL;

-- Read RPC for the rider-facing seat picker: which seat numbers are
-- already taken for this route/date/direction, so the UI can grey
-- them out before the rider even tries to tap one. Includes both the
-- ad-hoc hold table (for this exact date) and every live monthly
-- subscription's permanent seat (which blocks every date).
CREATE OR REPLACE FUNCTION route_seat_status(p_route_id uuid, p_travel_date date, p_direction varchar DEFAULT 'outbound')
RETURNS int[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT seat_number), '{}'::int[]) FROM (
    SELECT sn.seat_number FROM ride_booking_seat_numbers sn JOIN ride_bookings rb ON rb.id = sn.ride_booking_id
    WHERE sn.route_id = p_route_id AND sn.travel_date = p_travel_date AND sn.direction = p_direction
      AND rb.status IN ('announced', 'confirmed')
    UNION ALL
    SELECT rs.seat_number FROM route_subscriptions rs
    WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending') AND rs.seat_number IS NOT NULL
  ) taken;
$$;
GRANT EXECUTE ON FUNCTION route_seat_status(uuid, date, varchar) TO authenticated, anon;
