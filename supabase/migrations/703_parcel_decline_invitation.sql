-- Migration 703: found while building the parcel-delivery frontend —
-- the detail-page pattern it's modeled on (city-purchase/[id]) lets a
-- ringing-invited driver decline right there (decline_city_purchase_invitation,
-- 495); parcel delivery was missing its own equivalent.
CREATE OR REPLACE FUNCTION decline_parcel_delivery_invitation(p_delivery_id uuid, p_vehicle_id uuid) RETURNS void AS $$
DECLARE v_remaining int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE parcel_delivery_invitations SET status = 'declined', responded_at = now()
    WHERE delivery_id = p_delivery_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'This invitation is no longer pending.' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_remaining FROM parcel_delivery_invitations WHERE delivery_id = p_delivery_id AND status = 'ringing';
  IF v_remaining = 0 THEN
    UPDATE parcel_deliveries SET status = 'no_answer' WHERE id = p_delivery_id AND status = 'ringing';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION decline_parcel_delivery_invitation(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION decline_parcel_delivery_invitation(uuid, uuid) TO authenticated;
