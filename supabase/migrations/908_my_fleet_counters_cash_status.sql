-- Migration 908: Terminals screen rebuild (design-first plan, screen
-- 4) from safar_admin_dashboard-1.html's "Terminal directory" view,
-- which shows a real Active/Cash pending status per terminal.
-- fleet_counter_cash_positions (855) already computes real
-- cash-in-hand per counter (collected cash bookings minus remitted
-- amounts) — true-replacing my_fleet_counters (883) to fold that same
-- math in directly, so the Terminals page needs one RPC call, not two.
CREATE OR REPLACE FUNCTION my_fleet_counters(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'city', c.city, 'name', c.name, 'lat', c.lat, 'lng', c.lng, 'cash_office_code', c.cash_office_code,
    'manager_name', (SELECT pu.full_name FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id WHERE fs.counter_id = c.id LIMIT 1),
    'today_bookings_count', (
      SELECT COUNT(*) FROM manual_ride_bookings mb WHERE mb.counter_id = c.id AND mb.status = 'confirmed'
        AND mb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
    ),
    'cash_in_hand_pkr', COALESCE(collected.amt, 0) - COALESCE(remitted.amt, 0)
  ) ORDER BY c.city), '[]'::jsonb)
  FROM fleet_counters c
  LEFT JOIN LATERAL (
    SELECT SUM(mb.total_amount_pkr) AS amt FROM manual_ride_bookings mb
    WHERE mb.counter_id = c.id AND mb.payment_method = 'cash' AND mb.status = 'confirmed'
  ) collected ON true
  LEFT JOIN LATERAL (SELECT SUM(r.amount_pkr) AS amt FROM fleet_counter_remittances r WHERE r.counter_id = c.id) remitted ON true
  WHERE c.fleet_id = p_fleet_id
    AND (EXISTS (SELECT 1 FROM fleets f WHERE f.id = c.fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = c.fleet_id AND fs.portal_user_id = current_portal_user_id()));
$$;
