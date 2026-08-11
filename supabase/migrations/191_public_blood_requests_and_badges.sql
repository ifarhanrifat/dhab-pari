-- Migration 191: let anyone raise a blood request, and badge the sidebars.
--
-- Until now a request could only be created by a committee member typing up a
-- phone call. That is safe but it puts a person at 2am in the position of
-- finding someone's number first. This opens the form to everyone —
-- registered or not — while keeping the thing that actually made the old flow
-- safe: nothing reaches a single donor until a committee member has phoned the
-- requester back and said so.
--
-- So the gate does not move. It just moves later: submit freely, approve only
-- after a call.

-- ── 1. Where the request came from ───────────────────────────────────────
ALTER TABLE blood_requests
  ADD COLUMN IF NOT EXISTS source varchar NOT NULL DEFAULT 'phone_call'
    CHECK (source IN ('phone_call', 'public_form')),
  ADD COLUMN IF NOT EXISTS submitted_by_portal_user_id uuid REFERENCES portal_users(id),
  -- Set when the approver confirms they spoke to the requester. Separate from
  -- approved_at because "I approved it" and "I verified it by phone" are
  -- different claims, and only the second one protects the donors.
  ADD COLUMN IF NOT EXISTS verified_by_call boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS blood_requests_pending_idx
  ON blood_requests(status) WHERE status = 'pending_approval';

-- ── 2. Public submission ─────────────────────────────────────────────────
-- An open endpoint on the public internet needs a throttle, and we have no IP
-- address to throttle on inside Postgres. The requester's own number is the
-- next best key: a real family raising a real request does not need a third
-- pending one, and the number is the thing the committee will phone anyway, so
-- a spammer who churns numbers gets caught at the call instead.
--
-- The hourly ceiling is the blunt instrument for the case the per-number limit
-- cannot see: someone scripting fresh numbers. Thirty an hour is far beyond
-- any real village volume, and when it trips the form stops rather than
-- filling the committee's screen with a thousand rows to sift.
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
  p_needed_time varchar DEFAULT NULL,
  p_notes text DEFAULT NULL
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

  -- A number we cannot ring is a request we cannot verify, so it is not a
  -- request at all.
  v_digits := regexp_replace(coalesce(p_requester_whatsapp, ''), '[^0-9]', '', 'g');
  IF length(v_digits) < 10 OR length(v_digits) > 15 THEN
    RAISE EXCEPTION 'Enter a working mobile number — the committee has to phone you back before contacting any donor';
  END IF;

  IF p_units_needed IS NULL OR p_units_needed < 1 OR p_units_needed > 10 THEN
    RAISE EXCEPTION 'Units needed must be between 1 and 10';
  END IF;

  -- One day of slack: the server runs on UTC and Pakistan is five hours ahead,
  -- so "today" in Chakwal can still read as yesterday here.
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

  -- Null for a signed-out visitor; that is fine and expected.
  SELECT id INTO v_portal_user FROM portal_users WHERE auth_user_id = auth.uid() AND is_active = true;

  INSERT INTO blood_requests (
    patient_name, requester_name, requester_whatsapp, requester_relation,
    blood_group, units_needed, city, hospital, needed_on, needed_time, notes,
    status, source, submitted_by_portal_user_id, taken_by_admin_user_id
  ) VALUES (
    trim(p_patient_name), trim(p_requester_name), trim(p_requester_whatsapp),
    nullif(trim(coalesce(p_requester_relation, '')), ''),
    p_blood_group, p_units_needed, trim(p_city), trim(p_hospital),
    p_needed_on, nullif(trim(coalesce(p_needed_time, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    'pending_approval', 'public_form', v_portal_user, NULL
  )
  RETURNING id INTO v_id;

  -- Tell everyone who can act on it. A request nobody sees is worse than no
  -- form at all, because the person who filled it in believes help is coming.
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
        ' on ' || to_char(p_needed_on, 'DD/MM/YYYY') || '. Phone them before approving.',
      '/admin/blood-requests'
    );
  END LOOP;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION submit_blood_request(varchar, varchar, varchar, varchar, varchar, varchar, date, int, varchar, varchar, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_blood_request(varchar, varchar, varchar, varchar, varchar, varchar, date, int, varchar, varchar, text) TO anon, authenticated;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('blood_request_submitted', 'Someone submits a blood request from the website', false, true)
ON CONFLICT (event_type) DO NOTHING;

-- ── 3. Approval now records the phone call ───────────────────────────────
-- Dropped rather than replaced: CREATE OR REPLACE cannot add a parameter, it
-- would leave a second overload behind and make every call ambiguous.
DROP FUNCTION IF EXISTS approve_blood_request(uuid);

-- Body is migration 189's, unchanged apart from the call gate and the flag —
-- the matching, the notification wording and the return value all stay as they
-- were, so this adds a step rather than altering one.
CREATE OR REPLACE FUNCTION approve_blood_request(p_request_id uuid, p_called_requester boolean DEFAULT false)
RETURNS int AS $$
DECLARE
  r blood_requests%ROWTYPE;
  v_admin uuid;
  d record;
  v_count int := 0;
BEGIN
  IF NOT current_admin_permission('manage_blood_requests') THEN
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

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT bd.portal_user_id, 'blood_request',
           'Blood needed: ' || r.blood_group || ' — ' || r.hospital,
           r.units_needed || ' unit(s) for ' || r.patient_name || ' at ' || r.hospital || ', ' || r.city ||
             ' on ' || to_char(r.needed_on, 'DD/MM/YYYY') || COALESCE(' at ' || r.needed_time, '') ||
             '. Open Blood Donor to say yes or no.',
           '/portal/blood-donor'
      FROM blood_donors bd WHERE bd.id = d.blood_donor_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION approve_blood_request(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_blood_request(uuid, boolean) TO authenticated;

-- ── 4. Sidebar badges ────────────────────────────────────────────────────
-- One call per sidebar rather than a dozen counts fired from the client. Each
-- number means "this needs a person", not "this exists" — a badge that never
-- clears is a badge everyone learns to ignore.
CREATE OR REPLACE FUNCTION admin_sidebar_badges() RETURNS jsonb AS $$
DECLARE
  v_admin uuid;
  v_role varchar;
BEGIN
  SELECT id, role INTO v_admin, v_role
    FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true;
  IF v_admin IS NULL THEN RETURN '{}'::jsonb; END IF;

  RETURN jsonb_build_object(
    'blood_requests', (SELECT count(*) FROM blood_requests WHERE status = 'pending_approval'),
    'approvals',      (SELECT count(*) FROM approval_requests WHERE status = 'pending'),
    'alerts',         (SELECT count(*) FROM notifications WHERE recipient_id = v_admin AND is_read = false),
    'suggestions',    (SELECT count(*) FROM suggestions WHERE status = 'new'),
    'complaints',     (SELECT count(*) FROM complaints WHERE status IN ('open', 'awaiting_verification')),
    'volunteers',     (SELECT count(*) FROM volunteers WHERE status = 'offered'),
    'connections',    (SELECT count(*) FROM connection_requests WHERE status = 'pending_payment'),
    'payment_claims', (SELECT count(*) FROM bill_payment_claims WHERE status = 'pending'),
    -- Money a donor says they have sent but nobody has confirmed. It sits in
    -- neither the received total nor the announced one until someone looks.
    'donors',         (SELECT count(*) FROM donors WHERE payment_status = 'pledged' AND is_verified = false)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION admin_sidebar_badges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_sidebar_badges() TO authenticated;

-- The portal's badges come from the notifications the user has not opened,
-- bucketed by the page each one points at, so a new tab needs no new count
-- here — it just needs its notifications to link to it. The blood entry is the
-- exception: an unanswered request is outstanding whether or not the donor
-- ever saw the notification.
CREATE OR REPLACE FUNCTION portal_sidebar_badges() RETURNS jsonb AS $$
DECLARE
  v_user uuid;
  v_out jsonb;
BEGIN
  v_user := current_portal_user_id();
  IF v_user IS NULL THEN RETURN '{}'::jsonb; END IF;

  SELECT coalesce(jsonb_object_agg(page, n), '{}'::jsonb) INTO v_out
    FROM (
      SELECT split_part(ltrim(link, '/'), '/', 2) AS page, count(*) AS n
        FROM portal_notifications
       WHERE portal_user_id = v_user AND is_read = false AND link LIKE '/portal/%'
       GROUP BY 1
    ) s;

  RETURN v_out || jsonb_build_object(
    'blood-donor', (
      SELECT count(*)
        FROM blood_request_contacts c
        JOIN blood_requests r ON r.id = c.request_id
        JOIN blood_donors d ON d.id = c.blood_donor_id
       WHERE d.portal_user_id = v_user
         AND c.response = 'pending'
         AND c.stood_down_at IS NULL
         AND r.status = 'open'
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION portal_sidebar_badges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_sidebar_badges() TO authenticated;
