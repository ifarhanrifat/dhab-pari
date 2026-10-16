-- Migration 690: real gap -- closing a trip offer (driver cancels the
-- route) never touched the auto-generated commercial ilan advertising
-- it (migration 677's auto_generate_trip_ilan). The ad kept running on
-- the belt for a ride that no longer exists. Reproduced from the real
-- current body (no other change) and added: a still-pending ilan
-- request gets auto-rejected (nothing left to review); an
-- already-approved, already-paid-for ilan gets paused and its end
-- time pulled to now so it stops displaying immediately -- it keeps
-- its row and its voucher (real cash was already collected for it;
-- whether that's refundable is a committee decision, not this RPC's
-- to make), it just stops showing.

CREATE OR REPLACE FUNCTION public.close_trip_offer(p_trip_offer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = p_trip_offer_id AND v.portal_user_id = v_portal_user_id
  ) THEN RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicle_trip_offers SET status = 'closed' WHERE id = p_trip_offer_id;

  UPDATE commercial_ilans SET status = 'rejected', rejection_reason = 'Trip was cancelled by the driver before review.', reviewed_at = now()
    WHERE vehicle_trip_offer_id = p_trip_offer_id AND status = 'pending';

  UPDATE commercial_ilans SET is_paused = true, ends_at = now()
    WHERE vehicle_trip_offer_id = p_trip_offer_id AND status = 'approved' AND (ends_at IS NULL OR ends_at > now());
END;
$function$;
