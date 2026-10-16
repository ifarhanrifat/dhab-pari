-- Migration 677: two real, connected changes to the commercial ilan
-- system, both from direct feedback on migration 671-676:
--
-- 1. Approval + cash collection move from the platform team to each
--    village's OWN committee (a marketplace_accountant admin_user).
--    The real problem this fixes: a platform-run cash desk means an
--    advertiser from another village would have to travel to wherever
--    the platform's office is just to hand over cash -- a non-starter.
--    The rate card stays platform-controlled (one consistent price
--    everywhere); only approval and the physical cash-receipt step
--    move local. The platform's own cut comes later via the existing
--    platform_invoices commission line, not by personally holding cash.
--
-- 2. A vehicle posting a one-off trip (place_trip_offer, NOT the
--    recurring vehicle_routes commute -- that one runs indefinitely on
--    a weekly schedule and doesn't need re-announcing) gets a ticker
--    ilan generated and posted automatically, system-templated, no
--    content review needed (there's no free text to moderate) -- only
--    a one-click "cash received" confirmation, same shape as verifying
--    a donation. Deliberately no phone number in the auto text --
--    booking already happens through the existing in-app trip-booking
--    flow, and broadcasting a personal mobile number is an avoidable
--    risk this doesn't need to take.

-- ===================== Part 1: remove the platform-side collector ledger =====================

DROP FUNCTION IF EXISTS public.platform_approve_ilan(uuid);
DROP FUNCTION IF EXISTS public.platform_reject_ilan(uuid, text);
DROP FUNCTION IF EXISTS public.record_ilan_cash_settlement(decimal, text);
DROP FUNCTION IF EXISTS public.my_ilan_cash_held();
DROP TRIGGER IF EXISTS trg_platform_ilan_settlement_ledger ON platform_ilan_settlements;
DROP FUNCTION IF EXISTS public.trg_platform_ilan_settlement_ledger();
DROP TABLE IF EXISTS platform_ilan_settlements;
DROP TABLE IF EXISTS platform_ilan_ledger_entries;

-- reviewed_by now points at the committee admin who approved/rejected,
-- not a platform admin. Clear the one real row reviewed under the old
-- platform-admin flow first -- its platform_admins.id would never
-- satisfy the new admin_users FK, and the ilan itself stays approved
-- and live either way.
UPDATE commercial_ilans SET reviewed_by = NULL WHERE reviewed_by IS NOT NULL;
ALTER TABLE commercial_ilans DROP CONSTRAINT IF EXISTS commercial_ilans_reviewed_by_fkey;
ALTER TABLE commercial_ilans ADD CONSTRAINT commercial_ilans_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES admin_users(id);

-- A committee can see (and will shortly act on) its own village's own
-- advertisers' requests -- this was missing entirely; only the
-- advertiser themselves and a platform admin could read these rows
-- before.
CREATE POLICY commercial_ilans_committee_read ON commercial_ilans
  FOR SELECT TO authenticated
  USING (home_tenant_id = my_tenant_id() AND can_access_system('marketplace'));

CREATE OR REPLACE FUNCTION public.ensure_ilan_revenue_account(p_tenant_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_account_id uuid;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4060' AND tenant_id = p_tenant_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  INSERT INTO accounts (code, name, type, system, tenant_id, opening_balance)
  VALUES ('MKT-4060', 'Ilan Advertising Revenue', 'income', 'marketplace', p_tenant_id, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$;

-- Committee approval both confirms cash was collected AND, for a
-- manually-written ilan only, lets the admin tidy the wording before it
-- goes live -- an auto-generated trip ilan's text is system-built and
-- never passed through the edit params below.
CREATE OR REPLACE FUNCTION public.committee_approve_ilan(
  p_ilan_id uuid,
  p_edited_title_ur varchar DEFAULT NULL,
  p_edited_body_ur text DEFAULT NULL,
  p_edited_title_en varchar DEFAULT NULL,
  p_edited_body_en text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ilan commercial_ilans%rowtype;
  v_admin_id uuid := current_admin_user_id();
  v_cash_account uuid;
  v_revenue_account uuid;
BEGIN
  IF v_admin_id IS NULL OR NOT can_access_system('marketplace') OR NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'You do not have permission to approve ilans';
  END IF;

  SELECT * INTO ilan FROM commercial_ilans WHERE id = p_ilan_id AND home_tenant_id = my_tenant_id() AND status = 'pending_approval' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ilan not found or not pending approval';
  END IF;

  IF NOT ilan.is_auto_generated THEN
    UPDATE commercial_ilans SET
      title_ur = COALESCE(NULLIF(trim(p_edited_title_ur), ''), title_ur),
      body_ur = COALESCE(NULLIF(trim(p_edited_body_ur), ''), body_ur),
      title_en = COALESCE(NULLIF(trim(p_edited_title_en), ''), title_en),
      body_en = COALESCE(NULLIF(trim(p_edited_body_en), ''), body_en)
    WHERE id = p_ilan_id;
  END IF;

  UPDATE commercial_ilans SET status = 'approved', reviewed_by = v_admin_id, reviewed_at = now()
   WHERE id = p_ilan_id;

  IF ilan.price_pkr > 0 THEN
    v_revenue_account := ensure_ilan_revenue_account(ilan.home_tenant_id);
    SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-1001' AND tenant_id = ilan.home_tenant_id;
    IF v_cash_account IS NOT NULL THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Cash received for ilan — ' || ilan.title_ur, ilan.price_pkr, v_revenue_account, v_cash_account);
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.committee_reject_ilan(p_ilan_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin_id uuid := current_admin_user_id();
BEGIN
  IF v_admin_id IS NULL OR NOT can_access_system('marketplace') OR NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'You do not have permission to review ilans';
  END IF;
  UPDATE commercial_ilans SET status = 'rejected', rejection_reason = p_reason, reviewed_by = v_admin_id, reviewed_at = now()
   WHERE id = p_ilan_id AND home_tenant_id = my_tenant_id() AND status = 'pending_approval';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ilan not found or not pending approval';
  END IF;
END;
$$;

-- ===================== Part 2: automatic trip ilans =====================

ALTER TABLE commercial_ilans DROP CONSTRAINT IF EXISTS commercial_ilans_placement_check;
ALTER TABLE commercial_ilans ADD CONSTRAINT commercial_ilans_placement_check CHECK (placement IN ('ticker', 'banner', 'auto_trip'));
ALTER TABLE ilan_rate_cards DROP CONSTRAINT IF EXISTS ilan_rate_cards_placement_check;
ALTER TABLE ilan_rate_cards ADD CONSTRAINT ilan_rate_cards_placement_check CHECK (placement IN ('ticker', 'banner', 'auto_trip'));

ALTER TABLE commercial_ilans ADD COLUMN IF NOT EXISTS is_auto_generated boolean NOT NULL DEFAULT false;
ALTER TABLE commercial_ilans ADD COLUMN IF NOT EXISTS vehicle_trip_offer_id uuid REFERENCES vehicle_trip_offers(id);

INSERT INTO ilan_rate_cards (placement, price_per_village_per_day_pkr, min_hours, max_days)
SELECT 'auto_trip', 100, 1, 30
WHERE NOT EXISTS (SELECT 1 FROM ilan_rate_cards WHERE placement = 'auto_trip');

-- A flat per-post fee, not villages x days -- "auto_trip" always
-- targets exactly one village (the vehicle's own) for exactly as long
-- as the trip is bookable, so price_per_village_per_day_pkr here is
-- read as a flat price per post, not multiplied by anything.
CREATE OR REPLACE FUNCTION public.auto_generate_trip_ilan(p_trip_offer_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o vehicle_trip_offers%rowtype;
  v vehicles%rowtype;
  v_price decimal;
  v_dest text;
  v_date_ur text;
  v_time_ur text;
  v_body_ur text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_id uuid;
  v_month_names text[] := ARRAY['جنوری','فروری','مارچ','اپریل','مئی','جون','جولائی','اگست','ستمبر','اکتوبر','نومبر','دسمبر'];
BEGIN
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v FROM vehicles WHERE id = o.vehicle_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT price_per_village_per_day_pkr INTO v_price FROM ilan_rate_cards WHERE placement = 'auto_trip' AND is_active = true LIMIT 1;
  IF v_price IS NULL THEN RETURN NULL; END IF;

  v_dest := COALESCE(o.destination_ur, o.destination);
  v_date_ur := extract(day FROM o.travel_date) || ' ' || v_month_names[extract(month FROM o.travel_date)::int] || ' ' || extract(year FROM o.travel_date);

  IF o.departure_time_estimate IS NOT NULL THEN
    v_time_ur := CASE
      WHEN extract(hour FROM o.departure_time_estimate) < 12 THEN trim(to_char(o.departure_time_estimate, 'HH12:MI')) || ' صبح'
      WHEN extract(hour FROM o.departure_time_estimate) < 17 THEN trim(to_char(o.departure_time_estimate, 'HH12:MI')) || ' دوپہر'
      ELSE trim(to_char(o.departure_time_estimate, 'HH12:MI')) || ' شام'
    END;
  END IF;

  v_body_ur := v.vehicle_type || ' ' || v_dest || ' جا رہی ہے، ' || v_date_ur
    || CASE WHEN v_time_ur IS NOT NULL THEN ' بوقت ' || v_time_ur ELSE '' END
    || CASE WHEN o.trip_type = 'return' THEN ' (واپسی بھی دستیاب)' ELSE '' END
    || '۔ کرایہ فی مسافر ' || round(o.listed_fare_per_seat_pkr)::text || ' روپے۔ نشست محفوظ کروانے کے لیے مارکیٹ پلیس وزٹ کریں۔';

  v_starts_at := now();
  v_ends_at := GREATEST(
    (o.travel_date::timestamp + COALESCE(o.departure_time_estimate, '23:59'::time)) AT TIME ZONE 'Asia/Karachi',
    v_starts_at + interval '1 hour'
  );

  INSERT INTO commercial_ilans (
    advertiser_portal_user_id, home_tenant_id, vehicle_id, vehicle_trip_offer_id, placement,
    target_tenant_ids, title_ur, body_ur, starts_at, ends_at,
    rate_card_id, price_pkr, status, is_auto_generated
  )
  SELECT
    v.portal_user_id, v.tenant_id, v.id, p_trip_offer_id, 'auto_trip',
    ARRAY[v.tenant_id], 'سفری اعلان', v_body_ur, v_starts_at, v_ends_at,
    rc.id, v_price, 'pending_approval', true
  FROM ilan_rate_cards rc WHERE rc.placement = 'auto_trip' AND rc.is_active = true LIMIT 1
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Reproduced from its real, current body, with one added call at the
-- end -- every existing line, check and error message is untouched.
-- Wrapped so a problem generating the auto-ilan (e.g. no rate card yet)
-- never blocks the actual trip post, which is the thing the driver
-- actually asked for.
CREATE OR REPLACE FUNCTION public.place_trip_offer(p_vehicle_id uuid, p_trip_type character varying, p_origin character varying, p_origin_ur character varying, p_destination character varying, p_destination_ur character varying, p_classification character varying, p_travel_date date, p_departure_time_estimate time without time zone, p_seats_available integer, p_listed_fare_per_seat_pkr numeric, p_distance_km numeric DEFAULT NULL::numeric, p_dest_lat numeric DEFAULT NULL::numeric, p_dest_lng numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_allows_out_of_city boolean; v_is_online boolean;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT allows_out_of_city, is_online INTO v_allows_out_of_city, v_is_online FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_is_online THEN RAISE EXCEPTION 'Go online first — you can''t post a new trip while offline.' USING ERRCODE = 'P0001'; END IF;
  IF NOT vehicle_ride_eligible(p_vehicle_id) THEN
    RAISE EXCEPTION 'Your vehicle''s class is not enabled for rides — ask the committee.' USING ERRCODE = 'P0001';
  END IF;
  IF p_trip_type NOT IN ('oneway', 'return') THEN RAISE EXCEPTION 'Pick one-way or return.' USING ERRCODE = 'P0001'; END IF;
  IF p_classification = 'out_of_city' AND NOT v_allows_out_of_city THEN
    RAISE EXCEPTION 'This vehicle is only set up for trips within the home city — ask the committee if you need out-of-station enabled.' USING ERRCODE = 'P0001';
  END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_available IS NULL OR p_seats_available <= 0 THEN RAISE EXCEPTION 'Enter how many seats are free.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km, dest_lat, dest_lng)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km, p_dest_lat, p_dest_lng)
  RETURNING id INTO v_id;

  BEGIN
    PERFORM auto_generate_trip_ilan(v_id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_id;
END;
$function$;
