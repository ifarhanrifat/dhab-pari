-- Migration 194: describe the patient without naming them, put the time in
-- words people actually use, and write to donors in Urdu.
--
-- Three things this fixes:
--
--   1. A public appeal cannot carry the patient's name, but "blood needed"
--      with no subject reads like a scam. Naming the patient as "a villager
--      (woman)" gives a reader enough to believe it without identifying anyone.
--
--   2. needed_time was a free-text varchar. Nobody in Chakwal says "16:00" —
--      they say "شام 4 بجے". Free text also cannot be translated, so the same
--      string leaked English into an Urdu message. Now stored as an hour plus
--      a period, and rendered per language.
--
--   3. The notification a donor receives was English. The people being asked
--      to give blood read Urdu, and it went out without the requester's number
--      — so a donor who wanted to say yes had nobody to ring.

ALTER TABLE blood_requests
  ADD COLUMN IF NOT EXISTS patient_kind varchar
    CHECK (patient_kind IN ('man', 'woman', 'child')),
  ADD COLUMN IF NOT EXISTS needed_hour int
    CHECK (needed_hour BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS needed_period varchar
    CHECK (needed_period IN ('subha', 'dopahar', 'shaam', 'raat'));

-- ── Wording helpers ──────────────────────────────────────────────────────
-- Kept as functions rather than inlined, because the same phrasing has to come
-- out identically in the donor notification, the public appeal and the portal
-- banner. Three copies of this drift within a week.

CREATE OR REPLACE FUNCTION blood_patient_label_ur(p_kind varchar) RETURNS text AS $$
  SELECT CASE p_kind
    WHEN 'man'   THEN 'مرد'
    WHEN 'woman' THEN 'خاتون'
    WHEN 'child' THEN 'بچے'
    ELSE 'مریض'
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION blood_patient_label_en(p_kind varchar) RETURNS text AS $$
  SELECT CASE p_kind
    WHEN 'man'   THEN 'man'
    WHEN 'woman' THEN 'woman'
    WHEN 'child' THEN 'child'
    ELSE 'patient'
  END;
$$ LANGUAGE sql IMMUTABLE;

-- 'صبح 4 بجے'. Falls back to whatever free text is in needed_time for rows
-- created before this migration, so old requests still read sensibly.
CREATE OR REPLACE FUNCTION blood_time_ur(p_hour int, p_period varchar, p_legacy varchar DEFAULT NULL)
RETURNS text AS $$
  SELECT CASE
    WHEN p_hour IS NULL OR p_period IS NULL THEN nullif(trim(coalesce(p_legacy, '')), '')
    ELSE (CASE p_period
      WHEN 'subha'   THEN 'صبح'
      WHEN 'dopahar' THEN 'دوپہر'
      WHEN 'shaam'   THEN 'شام'
      WHEN 'raat'    THEN 'رات'
    END) || ' ' || p_hour::text || ' بجے'
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION blood_time_en(p_hour int, p_period varchar, p_legacy varchar DEFAULT NULL)
RETURNS text AS $$
  SELECT CASE
    WHEN p_hour IS NULL OR p_period IS NULL THEN nullif(trim(coalesce(p_legacy, '')), '')
    ELSE p_hour::text || (CASE p_period
      WHEN 'subha'   THEN ' in the morning'
      WHEN 'dopahar' THEN ' in the afternoon'
      WHEN 'shaam'   THEN ' in the evening'
      WHEN 'raat'    THEN ' at night'
    END)
  END;
$$ LANGUAGE sql IMMUTABLE;

-- "today" / "tomorrow" beat a date when the thing is hours away. Compared
-- against the Pakistan calendar, not the server's — the database runs on UTC,
-- where Pakistan's evening is still the previous day, and a request for
-- tonight would otherwise announce itself as tomorrow.
CREATE OR REPLACE FUNCTION blood_day_ur(p_date date) RETURNS text AS $$
  SELECT CASE
    WHEN p_date = (now() AT TIME ZONE 'Asia/Karachi')::date     THEN 'آج'
    WHEN p_date = (now() AT TIME ZONE 'Asia/Karachi')::date + 1 THEN 'کل'
    ELSE to_char(p_date, 'DD/MM/YYYY')
  END;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION blood_day_en(p_date date) RETURNS text AS $$
  SELECT CASE
    WHEN p_date = (now() AT TIME ZONE 'Asia/Karachi')::date     THEN 'today'
    WHEN p_date = (now() AT TIME ZONE 'Asia/Karachi')::date + 1 THEN 'tomorrow'
    ELSE 'on ' || to_char(p_date, 'DD/MM/YYYY')
  END;
$$ LANGUAGE sql STABLE;

-- The committee's own number, so every message carries a second way through
-- when the requester does not pick up.
CREATE OR REPLACE FUNCTION committee_contact_number() RETURNS text AS $$
  SELECT COALESCE(
    nullif(trim((SELECT value FROM site_settings WHERE key = 'whatsapp_number')), ''),
    nullif(trim((SELECT value FROM site_settings WHERE key = 'footer_whatsapp_chat')), '')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ── The public wording, with no patient name in it ───────────────────────
-- "ڈھاب پڑی کے ایک مریض (خاتون) کے لیے O+ خون کی 4 بوتلیں درکار ہیں — کل صبح 4
--  بجے، سی ایم ایچ ہسپتال، راولپنڈی۔ رابطہ: ..."
CREATE OR REPLACE FUNCTION blood_appeal_text_ur(p_request_id uuid, p_contact_number varchar DEFAULT NULL)
RETURNS text AS $$
DECLARE r blood_requests%ROWTYPE; v_when text; v_contact text; v_committee text;
BEGIN
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

  v_when := blood_day_ur(r.needed_on)
            || COALESCE(' ' || blood_time_ur(r.needed_hour, r.needed_period, r.needed_time), '');
  v_contact := COALESCE(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp);
  v_committee := committee_contact_number();

  RETURN 'ڈھاب پڑی کے ایک مریض (' || blood_patient_label_ur(r.patient_kind) || ') کے لیے '
      || r.blood_group || ' خون کی ' || r.units_needed::text || ' '
      || CASE WHEN r.units_needed = 1 THEN 'بوتل' ELSE 'بوتلیں' END || ' درکار ہیں — '
      || v_when || '، ' || r.hospital || '، ' || r.city || '۔ '
      || 'رابطہ: ' || v_contact
      || COALESCE(' یا کمیٹی: ' || v_committee, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION blood_appeal_text_en(p_request_id uuid, p_contact_number varchar DEFAULT NULL)
RETURNS text AS $$
DECLARE r blood_requests%ROWTYPE; v_when text; v_contact text; v_committee text;
BEGIN
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

  v_when := blood_day_en(r.needed_on)
            || COALESCE(' at ' || blood_time_en(r.needed_hour, r.needed_period, r.needed_time), '');
  v_contact := COALESCE(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp);
  v_committee := committee_contact_number();

  RETURN 'A villager (' || blood_patient_label_en(r.patient_kind) || ') needs '
      || r.units_needed::text || ' unit' || CASE WHEN r.units_needed = 1 THEN '' ELSE 's' END
      || ' of ' || r.blood_group || ' blood — ' || v_when || ', '
      || r.hospital || ', ' || r.city || '. '
      || 'Contact: ' || v_contact
      || COALESCE(' or the committee: ' || v_committee, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION blood_appeal_text_ur(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION blood_appeal_text_en(uuid, varchar) TO authenticated;
REVOKE ALL ON FUNCTION blood_appeal_text_ur(uuid, varchar) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION blood_appeal_text_en(uuid, varchar) FROM PUBLIC, anon;

-- ── Submission now takes the patient description and the structured time ──
-- Dropped and recreated: adding parameters to a function only creates a second
-- overload, and two candidates with defaulted arguments make every call
-- ambiguous.
DROP FUNCTION IF EXISTS submit_blood_request(varchar, varchar, varchar, varchar, varchar, varchar, date, int, varchar, varchar, text);

CREATE OR REPLACE FUNCTION submit_blood_request(
  p_patient_name varchar,
  p_requester_name varchar,
  p_requester_whatsapp varchar,
  p_blood_group varchar,
  p_city varchar,
  p_hospital varchar,
  p_needed_on date,
  p_units_needed int DEFAULT 1,
  p_requester_relation varchar DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_patient_kind varchar DEFAULT NULL,
  p_needed_hour int DEFAULT NULL,
  p_needed_period varchar DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_id uuid;
  v_digits text;
  v_portal_user uuid;
  v_pending int;
  v_recent int;
  v_flood int;
  r record;
BEGIN
  IF coalesce(trim(p_patient_name), '') = '' THEN RAISE EXCEPTION 'Enter the patient name'; END IF;
  IF coalesce(trim(p_requester_name), '') = '' THEN RAISE EXCEPTION 'Enter your name'; END IF;
  IF coalesce(trim(p_hospital), '') = '' THEN RAISE EXCEPTION 'Enter the hospital'; END IF;
  IF coalesce(trim(p_city), '') = '' THEN RAISE EXCEPTION 'Enter the city'; END IF;

  IF p_blood_group NOT IN ('A+','A-','B+','B-','AB+','AB-','O+','O-') THEN
    RAISE EXCEPTION 'Choose a valid blood group';
  END IF;

  -- Required, because the public appeal has to describe the patient without
  -- naming them and there is nothing else to say instead.
  IF p_patient_kind IS NULL OR p_patient_kind NOT IN ('man', 'woman', 'child') THEN
    RAISE EXCEPTION 'Say whether the patient is a man, a woman or a child';
  END IF;

  IF p_needed_hour IS NULL OR p_needed_hour < 1 OR p_needed_hour > 12
     OR p_needed_period IS NULL OR p_needed_period NOT IN ('subha','dopahar','shaam','raat') THEN
    RAISE EXCEPTION 'Choose the time the blood is needed';
  END IF;

  v_digits := regexp_replace(coalesce(p_requester_whatsapp, ''), '[^0-9]', '', 'g');
  IF length(v_digits) < 10 OR length(v_digits) > 15 THEN
    RAISE EXCEPTION 'Enter a working mobile number — the committee has to phone you back before contacting any donor';
  END IF;

  IF p_units_needed IS NULL OR p_units_needed < 1 OR p_units_needed > 10 THEN
    RAISE EXCEPTION 'Units needed must be between 1 and 10';
  END IF;

  IF p_needed_on IS NULL OR p_needed_on < current_date - 1 THEN
    RAISE EXCEPTION 'The date needed cannot be in the past';
  END IF;
  IF p_needed_on > current_date + 90 THEN
    RAISE EXCEPTION 'Raise the request closer to the date — donors cannot be held for three months';
  END IF;

  SELECT count(*) INTO v_pending FROM blood_requests
   WHERE regexp_replace(requester_whatsapp, '[^0-9]', '', 'g') = v_digits
     AND status = 'pending_approval';
  IF v_pending >= 2 THEN
    RAISE EXCEPTION 'You already have % requests waiting for the committee to call you back. Please wait for that call.', v_pending;
  END IF;

  SELECT count(*) INTO v_recent FROM blood_requests
   WHERE regexp_replace(requester_whatsapp, '[^0-9]', '', 'g') = v_digits
     AND created_at > now() - interval '24 hours';
  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'Too many requests from this number today. Please phone the committee instead.';
  END IF;

  SELECT count(*) INTO v_flood FROM blood_requests
   WHERE source = 'public_form' AND created_at > now() - interval '1 hour';
  IF v_flood >= 30 THEN
    RAISE EXCEPTION 'The form is temporarily closed because of unusual traffic. Please phone the committee.';
  END IF;

  SELECT id INTO v_portal_user FROM portal_users WHERE auth_user_id = auth.uid() AND is_active = true;

  INSERT INTO blood_requests (
    patient_name, patient_kind, requester_name, requester_whatsapp, requester_relation,
    blood_group, units_needed, city, hospital, needed_on, needed_hour, needed_period, notes,
    status, source, submitted_by_portal_user_id, taken_by_admin_user_id
  ) VALUES (
    trim(p_patient_name), p_patient_kind, trim(p_requester_name), trim(p_requester_whatsapp),
    nullif(trim(coalesce(p_requester_relation, '')), ''),
    p_blood_group, p_units_needed, trim(p_city), trim(p_hospital),
    p_needed_on, p_needed_hour, p_needed_period,
    nullif(trim(coalesce(p_notes, '')), ''),
    'pending_approval', 'public_form', v_portal_user, NULL
  )
  RETURNING id INTO v_id;

  FOR r IN
    SELECT id FROM admin_users
     WHERE is_active = true
       AND (role = 'super_admin' OR can_manage_blood_requests = true)
  LOOP
    INSERT INTO notifications (recipient_id, event_type, title, body, link)
    VALUES (
      r.id, 'blood_request_submitted',
      p_blood_group || ' blood requested — call to verify',
      trim(p_requester_name) || ' (' || trim(p_requester_whatsapp) || ') for ' ||
        trim(p_hospital) || ', ' || trim(p_city) ||
        ' ' || blood_day_en(p_needed_on) || '. Phone them before approving.',
      '/admin/blood-requests'
    );
  END LOOP;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION submit_blood_request(varchar, varchar, varchar, varchar, varchar, varchar, date, int, varchar, text, varchar, int, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_blood_request(varchar, varchar, varchar, varchar, varchar, varchar, date, int, varchar, text, varchar, int, varchar) TO anon, authenticated;

-- ── The donor's notification, in Urdu, with numbers to ring ──────────────
-- Written out in full rather than string-patched: the block being replaced
-- spans several lines and is full of quotes, and a near-miss in a textual
-- replacement either fails the push or silently patches the wrong thing.
--
-- This is migration 191's body with 192's NULL-safe guard — both taken from
-- the migration files in this repo, not from memory, which is the distinction
-- that made the 188 rewrite dangerous. The only deliberate change is the
-- notification: Urdu, and carrying both the requester's number and the
-- committee's, so a donor who wants to say yes has someone to ring.
CREATE OR REPLACE FUNCTION approve_blood_request(p_request_id uuid, p_called_requester boolean DEFAULT false)
RETURNS int AS $$
DECLARE
  r blood_requests%ROWTYPE;
  v_admin uuid;
  d record;
  v_count int := 0;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to approve blood requests';
  END IF;
  v_admin := current_admin_user_id();

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only a request awaiting approval can be approved — this one is %', r.status;
  END IF;

  -- The one rule that makes an open form safe. A request typed up from a call
  -- the committee itself received has already been verified by definition; one
  -- that arrived from the website has not, and approving it un-phoned is
  -- exactly how forty villagers get woken at 2am for a hoax.
  IF r.source = 'public_form' AND NOT p_called_requester THEN
    RAISE EXCEPTION 'Phone % on % first, then confirm you spoke to them.', r.requester_name, r.requester_whatsapp;
  END IF;

  UPDATE blood_requests
     SET status = 'open', approved_by_admin_user_id = v_admin, approved_at = now(),
         verified_by_call = (p_called_requester OR source = 'phone_call')
   WHERE id = p_request_id;

  -- Registered donors hear immediately in the portal. Anyone without a portal
  -- account is reached by the committee from the same matched list, by hand.
  FOR d IN SELECT * FROM eligible_blood_donors(p_request_id) LOOP
    INSERT INTO blood_request_contacts (request_id, blood_donor_id, contacted_by_admin_user_id, channel)
    VALUES (p_request_id, d.blood_donor_id, v_admin, 'portal')
    ON CONFLICT (request_id, blood_donor_id) DO NOTHING;

    -- The patient is named here, unlike in the public appeal: this goes to one
    -- matched donor privately, and someone being asked to give blood is owed
    -- more than a stranger reading a ticker.
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT bd.portal_user_id, 'blood_request',
           r.blood_group || ' خون کی ضرورت — ' || blood_day_ur(r.needed_on),
           'ڈھاب پڑی کے ایک مریض (' || blood_patient_label_ur(r.patient_kind) || ') کے لیے ' ||
             r.blood_group || ' خون کی ' || r.units_needed::text || ' ' ||
             CASE WHEN r.units_needed = 1 THEN 'بوتل' ELSE 'بوتلیں' END || ' درکار ہیں۔' ||
             ' وقت: ' || blood_day_ur(r.needed_on) ||
             COALESCE(' ' || blood_time_ur(r.needed_hour, r.needed_period, r.needed_time), '') ||
             '۔ ہسپتال: ' || r.hospital || '، ' || r.city ||
             '۔ رابطہ: ' || r.requester_name || ' ' || r.requester_whatsapp ||
             COALESCE(' یا کمیٹی: ' || committee_contact_number(), '') ||
             '۔ اگر آپ خون دے سکتے ہیں تو پورٹل میں خون کا عطیہ کھول کر ہاں یا نہ بتائیں۔',
           '/portal/blood-donor'
      FROM blood_donors bd WHERE bd.id = d.blood_donor_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION approve_blood_request(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_blood_request(uuid, boolean) TO authenticated;
