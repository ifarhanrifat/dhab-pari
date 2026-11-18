-- Migration 910: Terminals screen honesty pass — real gap found
-- re-checking the mockup against the live screen: create_fleet_counter
-- (883) already accepts lat/lng, but the Counters page's own "Add"
-- form never exposed them, and there was no way at all to edit a
-- counter (city/name/GPS/cash office code) once created — no "Manage"
-- action existed anywhere, unlike the mockup's terminal directory.
CREATE OR REPLACE FUNCTION update_fleet_counter(
  p_counter_id uuid, p_city varchar, p_name varchar DEFAULT NULL, p_lat decimal DEFAULT NULL, p_lng decimal DEFAULT NULL, p_cash_office_code varchar DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fleet_counters c JOIN fleets f ON f.id = c.fleet_id
    WHERE c.id = p_counter_id AND f.owning_portal_user_id = current_portal_user_id()
  ) THEN RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_city, '')) = '' THEN RAISE EXCEPTION 'Enter the counter''s city.' USING ERRCODE = 'P0001'; END IF;

  UPDATE fleet_counters SET
    city = trim(p_city), name = nullif(trim(coalesce(p_name, '')), ''),
    lat = p_lat, lng = p_lng, cash_office_code = nullif(trim(coalesce(p_cash_office_code, '')), '')
  WHERE id = p_counter_id;
END;
$$;
REVOKE ALL ON FUNCTION update_fleet_counter(uuid, varchar, varchar, decimal, decimal, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_fleet_counter(uuid, varchar, varchar, decimal, decimal, varchar) TO authenticated;
