-- Migration 411: ride_booking_context() crashed confirm_ride_booking with
-- a NOT NULL violation on vouchers.particular if an adda's pair_adda_id
-- was ever NULL (an admin adds one stand before pairing it, or a booking
-- somehow targets an entry whose adda lost its pair) — destination
-- resolved to a bare NULL instead of degrading gracefully. Caught by the
-- adda booking verification test, not a real production booking; the two
-- real seeded addas (409) are already paired.
CREATE OR REPLACE FUNCTION ride_booking_context(p_booking_id uuid)
RETURNS TABLE(origin varchar, destination varchar, classification varchar, vehicle_id uuid) AS $$
  SELECT
    COALESCE(vr.origin, a.name, 'Unknown origin'),
    COALESCE(vr.destination, ap.name, 'Unknown destination'),
    COALESCE(vr.classification, a.classification, 'intercity'),
    COALESCE(vr.vehicle_id, aqe.vehicle_id)
  FROM ride_bookings b
  LEFT JOIN vehicle_routes vr ON vr.id = b.route_id
  LEFT JOIN adda_queue_entries aqe ON aqe.id = b.adda_queue_entry_id
  LEFT JOIN addas a ON a.id = aqe.adda_id
  LEFT JOIN addas ap ON ap.id = a.pair_adda_id
  WHERE b.id = p_booking_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
