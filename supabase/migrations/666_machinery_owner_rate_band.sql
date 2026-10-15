-- Migration 666: machine-driver self-set rate within a committee band
-- (item 5 of the 6 real gaps). Every other vehicle rate stays
-- admin-only (deliberate, confirmed again this session) -- machinery is
-- the one carve-out, because a specific crane/excavator/bulldozer is a
-- scarce, individually-priced asset in real life already, unlike a
-- standardized Suzuki pickup. Scoped to a BAND, not a free-for-all: the
-- committee sets a min/max hourly rate; the driver can only pick within
-- it. If the committee never sets a band (both NULL, the default), the
-- rate stays 100% admin-only exactly as it is today -- purely additive.
-- Tractor-implement rates (tractor_services, one row per implement) are
-- a natural follow-up using the identical pattern, not done here.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS machinery_hourly_rate_min_pkr decimal CHECK (machinery_hourly_rate_min_pkr IS NULL OR machinery_hourly_rate_min_pkr >= 0);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS machinery_hourly_rate_max_pkr decimal CHECK (machinery_hourly_rate_max_pkr IS NULL OR machinery_hourly_rate_max_pkr >= machinery_hourly_rate_min_pkr);

CREATE OR REPLACE FUNCTION set_own_machinery_rate(p_vehicle_id uuid, p_rate_pkr decimal) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id IS DISTINCT FROM current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v.offers_machinery THEN
    RAISE EXCEPTION 'Machinery hire is not enabled for this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF v.machinery_hourly_rate_min_pkr IS NULL OR v.machinery_hourly_rate_max_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set a rate range for you first.' USING ERRCODE = 'P0001';
  END IF;
  IF p_rate_pkr < v.machinery_hourly_rate_min_pkr OR p_rate_pkr > v.machinery_hourly_rate_max_pkr THEN
    RAISE EXCEPTION 'Pick a rate between % and % per hour.', v.machinery_hourly_rate_min_pkr, v.machinery_hourly_rate_max_pkr USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicles SET machinery_hourly_rate_pkr = p_rate_pkr WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_own_machinery_rate(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_own_machinery_rate(uuid, decimal) TO authenticated;
