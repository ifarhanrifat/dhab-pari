-- Phase 2, slice 10 (functions): every function touching only slice-10
-- tables -- every one of them is a news_ticker-adjacent blood-request/
-- appeal function. Reproduced from the real, current body (pulled live
-- via pg_get_functiondef) with only the minimal tenant-scoping fix
-- applied.
--
-- Admin-gated ID-lookup mutators with no tenant filter (the recurring bug
-- class this whole phase): cancel_blood_request, close_appeal,
-- fulfil_blood_request, post_blood_appeal, post_blood_request_ticker,
-- post_blood_thanks_ticker, update_appeal -- each loaded its target
-- blood_requests/appeals row by id with no check that it belonged to the
-- caller's own tenant.
--
-- notify_ticker_new_chanda / trg_donation_thanks_ticker: triggers
-- inserting into news_ticker relying on the DEFAULT tenant_id -- fixed
-- with the row's own tenant_id explicitly, consistent with every other
-- trigger fixed this phase.
--
-- close_appeals_for_blood_request, create_appeal, expire_ticker_messages,
-- sync_appeal_tickers are left unchanged: each is either keyed entirely
-- by an already-tenant-validated id (transitively safe) or a pure
-- status-transition sweep with no tenant-specific computation (same
-- precedent as expire_needs_register). reset_operational_data is left
-- unchanged, consistent with every other reset_* function this phase --
-- an intentionally platform-wide super-admin utility.

create or replace function public.cancel_blood_request(p_request_id uuid, p_reason text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r blood_requests%ROWTYPE;
  c record;
  v_count int := 0;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to cancel blood requests';
  END IF;
  IF COALESCE(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'Give a reason — donors are told why, and a fake call needs recording as one';
  END IF;

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status IN ('cancelled', 'fulfilled') THEN
    RAISE EXCEPTION 'This request is already %', r.status;
  END IF;

  UPDATE blood_requests
     SET status = 'cancelled', cancelled_by_admin_user_id = current_admin_user_id(),
         cancelled_at = now(), cancel_reason = p_reason
   WHERE id = p_request_id;

  FOR c IN SELECT bc.*, bd.portal_user_id FROM blood_request_contacts bc
           JOIN blood_donors bd ON bd.id = bc.blood_donor_id
          WHERE bc.request_id = p_request_id AND bc.stood_down_at IS NULL LOOP
    UPDATE blood_request_contacts SET stood_down_at = now() WHERE id = c.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (c.portal_user_id, 'blood_stand_down',
            'No longer needed — ' || r.blood_group || ' at ' || r.hospital,
            'The request has been cancelled. Please do not travel. Reason: ' || p_reason ||
              '. Thank you for being willing.',
            '/portal/blood-donor');
    v_count := v_count + 1;
  END LOOP;

  -- Pull any public ticker down with it.
  UPDATE news_ticker SET is_active = false WHERE id IN (r.ticker_id);
  PERFORM close_appeals_for_blood_request(p_request_id, 'request closed');
  RETURN v_count;
END;
$function$;

create or replace function public.close_appeal(p_appeal_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE a appeals%ROWTYPE;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to close an appeal';
  END IF;

  SELECT * INTO a FROM appeals WHERE id = p_appeal_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Appeal not found'; END IF;

  UPDATE appeals SET status = 'closed', closed_at = now(),
                     closed_by_admin_user_id = current_admin_user_id(),
                     close_reason = p_reason
   WHERE id = p_appeal_id;

  -- The ticker goes with it. An appeal that stays up after the need is met is
  -- worse than one that was never posted — it teaches people the appeals are
  -- stale and can be skipped.
  UPDATE news_ticker SET is_active = false WHERE id = a.ticker_id;
END;
$function$;

create or replace function public.fulfil_blood_request(p_request_id uuid, p_donor_ids uuid[], p_donated_on date DEFAULT NULL::date)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r blood_requests%ROWTYPE;
  c record;
  v_on date := COALESCE(p_donated_on, current_date);
  v_count int := 0;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to close blood requests';
  END IF;

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status IN ('cancelled', 'fulfilled') THEN
    RAISE EXCEPTION 'This request is already %', r.status;
  END IF;

  -- Marking who gave is what makes the register honest three months from now:
  -- it is the only thing that stops us calling them again too soon.
  UPDATE blood_request_contacts SET donated = true, response = 'yes', responded_at = COALESCE(responded_at, now())
   WHERE request_id = p_request_id AND blood_donor_id = ANY (p_donor_ids);

  UPDATE blood_donors SET last_donation_date = v_on, updated_at = now()
   WHERE id = ANY (p_donor_ids);

  UPDATE blood_requests SET status = 'fulfilled', fulfilled_at = now() WHERE id = p_request_id;

  -- Everyone else stands down.
  FOR c IN SELECT bc.*, bd.portal_user_id FROM blood_request_contacts bc
           JOIN blood_donors bd ON bd.id = bc.blood_donor_id
          WHERE bc.request_id = p_request_id AND bc.donated = false AND bc.stood_down_at IS NULL LOOP
    UPDATE blood_request_contacts SET stood_down_at = now() WHERE id = c.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (c.portal_user_id, 'blood_stand_down',
            'Arranged — thank you',
            'Blood for ' || r.patient_name || ' at ' || r.hospital || ' has been arranged. Please do not travel. Thank you for being willing to help.',
            '/portal/blood-donor');
    v_count := v_count + 1;
  END LOOP;

  UPDATE news_ticker SET is_active = false WHERE id IN (r.ticker_id);
  PERFORM close_appeals_for_blood_request(p_request_id, 'request closed');
  RETURN v_count;
END;
$function$;

create or replace function public.notify_ticker_new_chanda()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, tenant_id)
    VALUES (
      'New Chanda started: ' || NEW.title || ' — see dhabpari.com/chanda',
      'نیا چندہ شروع ہوا: ' || COALESCE(NEW.title_ur, NEW.title) || ' — دیکھیں dhabpari.com/chanda',
      true, -50, now() + (get_alert_expiry_hours('chanda_announcement') || ' hours')::interval, NEW.tenant_id
    );
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.post_blood_appeal(p_request_id uuid, p_contact_number character varying DEFAULT NULL::character varying, p_audience character varying DEFAULT 'everyone'::character varying, p_audience_countries text[] DEFAULT '{}'::text[], p_is_public boolean DEFAULT true)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE r blood_requests%ROWTYPE; v_id uuid; v_admin uuid; v_ticker uuid; v_expires_at timestamptz; v_title_ur varchar; v_body_ur text;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to post a blood appeal';
  END IF;

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION 'Only an open request can be posted publicly'; END IF;

  v_admin := current_admin_user_id();
  v_expires_at := (r.needed_on + 1)::timestamp AT TIME ZONE 'Asia/Karachi';
  v_title_ur := r.blood_group || ' خون کی ضرورت';
  v_body_ur := blood_appeal_text_ur(p_request_id, p_contact_number);

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       blood_request_id, expires_at, created_by_admin_user_id)
  VALUES ('blood', 'emergency',
          r.blood_group || ' blood needed', v_title_ur,
          blood_appeal_text_en(p_request_id, p_contact_number), v_body_ur,
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public,
          r.requester_name,
          coalesce(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp),
          p_request_id, v_expires_at, v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, is_appeal_mirror, tenant_id)
    VALUES (blood_appeal_text_en(p_request_id, p_contact_number), v_body_ur, true, -100, v_expires_at, true, r.tenant_id)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
    UPDATE blood_requests SET ticker_id = v_ticker WHERE id = p_request_id;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT a.portal_user_id, 'appeal', v_title_ur, v_body_ur, '/portal'
    FROM appeal_audience_users(p_audience, p_audience_countries) a;

  PERFORM notify_admins_pending_item('appeal', v_title_ur, v_body_ur, '/admin/notifications');

  RETURN v_id;
END;
$function$;

create or replace function public.post_blood_request_ticker(p_request_id uuid, p_contact_number character varying)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r blood_requests%ROWTYPE;
  v_id uuid;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to post a blood appeal';
  END IF;
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id AND tenant_id = my_tenant_id();
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION 'Only an open request can be posted publicly'; END IF;

  -- No patient name on the public ticker: their medical situation is not a
  -- village announcement. Group, place and a number to call is all it takes.
  INSERT INTO news_ticker (message, message_ur, is_active, display_order, tenant_id)
  VALUES (
    'URGENT: ' || r.blood_group || ' blood needed at ' || r.hospital || ', ' || r.city ||
      ' — please call ' || p_contact_number,
    'فوری ضرورت: ' || r.hospital || '، ' || r.city || ' میں ' || r.blood_group ||
      ' خون کی ضرورت ہے — براہ کرم ' || p_contact_number || ' پر رابطہ کریں',
    true, -100, r.tenant_id
  ) RETURNING id INTO v_id;

  UPDATE blood_requests SET ticker_id = v_id WHERE id = p_request_id;
  RETURN v_id;
END;
$function$;

create or replace function public.post_blood_thanks_ticker(p_request_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r blood_requests%ROWTYPE;
  v_names text;
  v_id uuid;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to post a thank-you';
  END IF;
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id AND tenant_id = my_tenant_id();
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'fulfilled' THEN RAISE EXCEPTION 'Thank donors once the request is fulfilled'; END IF;

  SELECT string_agg(pu.full_name, '، ' ORDER BY pu.full_name) INTO v_names
    FROM blood_request_contacts bc
    JOIN blood_donors bd ON bd.id = bc.blood_donor_id AND bd.allow_public_thanks
    JOIN portal_users pu ON pu.id = bd.portal_user_id
   WHERE bc.request_id = p_request_id AND bc.donated;

  INSERT INTO news_ticker (message, message_ur, is_active, display_order, tenant_id)
  VALUES (
    CASE WHEN v_names IS NULL
      THEN 'Thank you to those who donated blood this week — the committee is grateful.'
      ELSE 'Thank you to ' || v_names || ' for donating blood. The committee is grateful.' END,
    CASE WHEN v_names IS NULL
      THEN 'اس ہفتے خون کا عطیہ دینے والوں کا بہت شکریہ — کمیٹی مشکور ہے۔'
      ELSE 'شکریہ! ' || v_names || ' نے خون کا عطیہ دیا۔ کمیٹی مشکور ہے۔' END,
    true, -50, r.tenant_id
  ) RETURNING id INTO v_id;

  UPDATE blood_requests SET thanks_ticker_id = v_id WHERE id = p_request_id;
  RETURN v_id;
END;
$function$;

create or replace function public.trg_donation_thanks_ticker()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid; v_hours int; v_is_private boolean; v_hide_names boolean; v_text text;
BEGIN
  IF setting_text('donation_thanks_enabled', 'true') <> 'true' THEN RETURN NEW; END IF;
  IF NEW.is_verified IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_verified IS TRUE THEN RETURN NEW; END IF;

  IF NEW.project_id IS NOT NULL THEN
    SELECT is_private, hide_donor_names INTO v_is_private, v_hide_names FROM projects WHERE id = NEW.project_id;
    IF v_is_private OR v_hide_names THEN RETURN NEW; END IF;
  END IF;

  v_hours := COALESCE(nullif(setting_text('donation_thanks_hours', '24'), '')::int, 24);
  v_text := donation_thanks_text(NEW.id, 'ur');

  INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, tenant_id)
  VALUES (v_text, v_text, true, 0, now() + make_interval(hours => v_hours), NEW.tenant_id)
  RETURNING id INTO v_id;

  RETURN NEW;
END;
$function$;

create or replace function public.update_appeal(p_appeal_id uuid, p_kind character varying, p_body_ur text, p_body_en text, p_audience character varying DEFAULT 'everyone'::character varying, p_audience_countries text[] DEFAULT '{}'::text[], p_is_public boolean DEFAULT true, p_title_ur character varying DEFAULT NULL::character varying, p_contact_number character varying DEFAULT NULL::character varying, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_severity character varying DEFAULT 'appeal'::character varying, p_notify boolean DEFAULT true)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_ticker_id uuid; v_body_en text; v_title_ur varchar; v_expires_at timestamptz;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to edit an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in Urdu';
  END IF;

  SELECT ticker_id INTO v_ticker_id FROM appeals WHERE id = p_appeal_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Appeal not found'; END IF;

  v_body_en := COALESCE(NULLIF(trim(coalesce(p_body_en, '')), ''), trim(p_body_ur));
  v_title_ur := COALESCE(nullif(trim(coalesce(p_title_ur, '')), ''), 'ایک اپیل');
  v_expires_at := COALESCE(p_expires_at, now() + (get_alert_expiry_hours(p_severity || '_default') || ' hours')::interval);

  UPDATE appeals SET
    kind = p_kind, severity = p_severity, title_ur = p_title_ur,
    body_en = v_body_en, body_ur = trim(p_body_ur), audience = p_audience,
    audience_countries = coalesce(p_audience_countries, '{}'), is_public = p_is_public,
    contact_number = p_contact_number, expires_at = v_expires_at
  WHERE id = p_appeal_id;

  IF v_ticker_id IS NOT NULL THEN
    UPDATE news_ticker SET message = v_body_en, message_ur = trim(p_body_ur), expires_at = v_expires_at, is_active = p_is_public
    WHERE id = v_ticker_id;
  END IF;

  IF p_notify THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT a.portal_user_id, 'appeal', v_title_ur, trim(p_body_ur), '/portal'
      FROM appeal_audience_users(p_audience, p_audience_countries) a;

    PERFORM notify_admins_pending_item('appeal', v_title_ur, trim(p_body_ur), '/admin/notifications');
  END IF;
END;
$function$;
