-- Migration 693: real, confirmed gap — a rider had NO way to tell
-- whether a listed shared ride was one-way or return (browse_open_
-- trip_offers never even returned trip_type), and there was no price
-- difference between the two at all: a 'return' trip's single listed
-- fare was charged in full even to a rider who only wanted the
-- one-way leg. Real ask, 2026-10-17: for a 'return' listing, the
-- driver's quoted fare IS the return price; a rider who only books
-- one-way pays exactly half of it, and sees that choice clearly
-- before booking. A 'oneway' listing has no return option at all —
-- its quoted fare already is the (undiscounted) one-way price.

ALTER TABLE vehicle_trip_bookings ADD COLUMN IF NOT EXISTS leg character varying NOT NULL DEFAULT 'oneway'
  CHECK (leg IN ('oneway', 'return'));

CREATE OR REPLACE FUNCTION public.browse_open_trip_offers(p_city_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'vehicle_id', o.vehicle_id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'classification', o.classification, 'travel_date', o.travel_date, 'departure_time_estimate', o.departure_time_estimate,
    'seats_available', o.seats_available, 'listed_fare_per_seat_pkr', o.listed_fare_per_seat_pkr, 'trip_type', o.trip_type
  ) ORDER BY o.travel_date ASC, o.departure_time_estimate ASC NULLS LAST), '[]'::jsonb)
  FROM vehicle_trip_offers o
  JOIN vehicles v ON v.id = o.vehicle_id
  WHERE o.status = 'open' AND o.seats_available > 0
    AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    AND lower(trim(o.destination)) = lower(trim(p_city_key));
$function$;

-- Reproduced from 685/686's real current body, with one new p_leg
-- param. A 'oneway' trip ignores whatever leg is asked for — there is
-- no return option to choose on it. A 'return' trip prices a oneway
-- booking at exactly half its listed (return) fare.
CREATE OR REPLACE FUNCTION public.book_trip_offer(p_trip_offer_id uuid, p_seats_requested integer, p_leg character varying DEFAULT 'oneway')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  o vehicle_trip_offers%ROWTYPE;
  v_fare_offer_id uuid;
  v_booking_id uuid;
  v_leg character varying;
  v_fare_per_seat numeric;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'open' THEN RAISE EXCEPTION 'This trip is no longer available.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_requested IS NULL OR p_seats_requested <= 0 OR p_seats_requested > o.seats_available THEN
    RAISE EXCEPTION 'Only % seat(s) available on this trip.', o.seats_available USING ERRCODE = 'P0001';
  END IF;

  v_leg := CASE WHEN o.trip_type = 'return' AND p_leg = 'return' THEN 'return' ELSE 'oneway' END;
  v_fare_per_seat := CASE WHEN o.trip_type = 'return' AND v_leg = 'oneway' THEN round(o.listed_fare_per_seat_pkr / 2) ELSE o.listed_fare_per_seat_pkr END;

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr, status, responded_at)
  VALUES (p_trip_offer_id, v_portal_user_id, p_seats_requested, v_fare_per_seat, 'accepted', now())
  RETURNING id INTO v_fare_offer_id;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, leg)
  VALUES (o.id, v_fare_offer_id, o.vehicle_id, v_portal_user_id, p_seats_requested, v_fare_per_seat, p_seats_requested * v_fare_per_seat, v_leg)
  RETURNING id INTO v_booking_id;

  UPDATE vehicle_trip_offers SET seats_available = o.seats_available - p_seats_requested,
    status = CASE WHEN o.seats_available - p_seats_requested <= 0 THEN 'closed' ELSE status END
    WHERE id = o.id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'trip_booked', 'Seat booked',
    p_seats_requested || ' seat(s) booked (' || v_leg || ') at ' || v_fare_per_seat || '/seat for your ' || o.origin || ' → ' || o.destination || ' trip.', '/portal/my-vehicle/trips'
  FROM vehicles v WHERE v.id = o.vehicle_id AND v.portal_user_id IS NOT NULL;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'leg', v_leg, 'fare_per_seat', v_fare_per_seat);
END;
$function$;

-- Reproduced from 686's real current body, adding trip_type + leg so a
-- rider's own history shows exactly what they bought.
CREATE OR REPLACE FUNCTION public.my_trip_bookings()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'status', b.status, 'seats', b.seats, 'leg', b.leg,
    'agreed_fare_per_seat_pkr', b.agreed_fare_per_seat_pkr, 'total_amount_pkr', b.total_amount_pkr,
    'created_at', b.created_at, 'cancellation_reason', b.cancellation_reason,
    'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'travel_date', o.travel_date, 'departure_time_estimate', o.departure_time_estimate, 'trip_type', o.trip_type
  ) ORDER BY b.created_at DESC), '[]'::jsonb)
  FROM vehicle_trip_bookings b
  JOIN vehicle_trip_offers o ON o.id = b.trip_offer_id
  JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$function$;

-- Reproduced from 677's real current body — the ad text itself now
-- states the fare structure plainly instead of a vague "(return also
-- available)" with no price attached.
CREATE OR REPLACE FUNCTION public.auto_generate_trip_ilan(p_trip_offer_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_fare_line text;
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

  v_fare_line := CASE WHEN o.trip_type = 'return'
    THEN 'کرایہ فی مسافر (واپسی) ' || round(o.listed_fare_per_seat_pkr)::text || ' روپے — صرف ایک طرفہ کے لیے ' || round(o.listed_fare_per_seat_pkr / 2)::text || ' روپے (آدھا کرایہ)۔'
    ELSE 'کرایہ فی مسافر (صرف ایک طرفہ) ' || round(o.listed_fare_per_seat_pkr)::text || ' روپے۔' END;

  v_body_ur := v.vehicle_type || ' ' || v_dest || ' جا رہی ہے، ' || v_date_ur
    || CASE WHEN v_time_ur IS NOT NULL THEN ' بوقت ' || v_time_ur ELSE '' END
    || '۔ ' || v_fare_line || ' نشست محفوظ کروانے کے لیے مارکیٹ پلیس وزٹ کریں۔';

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
$function$;
