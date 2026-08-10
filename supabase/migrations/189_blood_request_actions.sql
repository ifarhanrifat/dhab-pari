-- Migration 189: the actions a blood request moves through.
--
-- Every one is an RPC rather than a client-side UPDATE, because each does
-- several things that must happen together — approve also notifies, cancel also
-- stands everyone down, fulfil also starts each donor's cool-off clock. Half of
-- any of those is worse than none.

-- ── Approve: pending_approval -> open, and tell matching donors ──────────
CREATE OR REPLACE FUNCTION approve_blood_request(p_request_id uuid) RETURNS int AS $$
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

  UPDATE blood_requests
     SET status = 'open', approved_by_admin_user_id = v_admin, approved_at = now()
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

-- ── Pause / resume ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_blood_request_paused(p_request_id uuid, p_paused boolean) RETURNS void AS $$
DECLARE r blood_requests%ROWTYPE;
BEGIN
  IF NOT current_admin_permission('manage_blood_requests') THEN
    RAISE EXCEPTION 'You do not have permission to change blood requests';
  END IF;
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status NOT IN ('open', 'paused') THEN
    RAISE EXCEPTION 'Only an open request can be paused — this one is %', r.status;
  END IF;
  UPDATE blood_requests SET status = CASE WHEN p_paused THEN 'paused' ELSE 'open' END
   WHERE id = p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Cancel: stand everyone down ──────────────────────────────────────────
-- The stand-down is the point. A registry that cancels quietly has donors
-- turning up to a ward where it was handled hours ago, and those donors do not
-- come back a second time.
CREATE OR REPLACE FUNCTION cancel_blood_request(p_request_id uuid, p_reason text) RETURNS int AS $$
DECLARE
  r blood_requests%ROWTYPE;
  c record;
  v_count int := 0;
BEGIN
  IF NOT current_admin_permission('manage_blood_requests') THEN
    RAISE EXCEPTION 'You do not have permission to cancel blood requests';
  END IF;
  IF COALESCE(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'Give a reason — donors are told why, and a fake call needs recording as one';
  END IF;

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id FOR UPDATE;
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
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Fulfil: record who actually gave, and start their clocks ─────────────
CREATE OR REPLACE FUNCTION fulfil_blood_request(p_request_id uuid, p_donor_ids uuid[], p_donated_on date DEFAULT NULL)
RETURNS int AS $$
DECLARE
  r blood_requests%ROWTYPE;
  c record;
  v_on date := COALESCE(p_donated_on, current_date);
  v_count int := 0;
BEGIN
  IF NOT current_admin_permission('manage_blood_requests') THEN
    RAISE EXCEPTION 'You do not have permission to close blood requests';
  END IF;

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id FOR UPDATE;
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
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Ticker: the public appeal, and the thank-you ─────────────────────────
-- A separate, deliberate action. This is the village's public homepage, and a
-- request that turns out to be fake will have been seen by far more people than
-- the donors themselves.
CREATE OR REPLACE FUNCTION post_blood_request_ticker(p_request_id uuid, p_contact_number varchar)
RETURNS uuid AS $$
DECLARE
  r blood_requests%ROWTYPE;
  v_id uuid;
BEGIN
  IF NOT current_admin_permission('manage_blood_requests') THEN
    RAISE EXCEPTION 'You do not have permission to post a blood appeal';
  END IF;
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION 'Only an open request can be posted publicly'; END IF;

  -- No patient name on the public ticker: their medical situation is not a
  -- village announcement. Group, place and a number to call is all it takes.
  INSERT INTO news_ticker (message, message_ur, is_active, display_order)
  VALUES (
    'URGENT: ' || r.blood_group || ' blood needed at ' || r.hospital || ', ' || r.city ||
      ' — please call ' || p_contact_number,
    'فوری ضرورت: ' || r.hospital || '، ' || r.city || ' میں ' || r.blood_group ||
      ' خون کی ضرورت ہے — براہ کرم ' || p_contact_number || ' پر رابطہ کریں',
    true, -100
  ) RETURNING id INTO v_id;

  UPDATE blood_requests SET ticker_id = v_id WHERE id = p_request_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Naming a donor publicly is not ours to assume — only those who ticked
-- allow_public_thanks appear. If nobody did, the committee is thanked instead
-- of nobody, so the village still sees that it worked.
CREATE OR REPLACE FUNCTION post_blood_thanks_ticker(p_request_id uuid) RETURNS uuid AS $$
DECLARE
  r blood_requests%ROWTYPE;
  v_names text;
  v_id uuid;
BEGIN
  IF NOT current_admin_permission('manage_blood_requests') THEN
    RAISE EXCEPTION 'You do not have permission to post a thank-you';
  END IF;
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'fulfilled' THEN RAISE EXCEPTION 'Thank donors once the request is fulfilled'; END IF;

  SELECT string_agg(pu.full_name, '، ' ORDER BY pu.full_name) INTO v_names
    FROM blood_request_contacts bc
    JOIN blood_donors bd ON bd.id = bc.blood_donor_id AND bd.allow_public_thanks
    JOIN portal_users pu ON pu.id = bd.portal_user_id
   WHERE bc.request_id = p_request_id AND bc.donated;

  INSERT INTO news_ticker (message, message_ur, is_active, display_order)
  VALUES (
    CASE WHEN v_names IS NULL
      THEN 'Thank you to those who donated blood this week — the committee is grateful.'
      ELSE 'Thank you to ' || v_names || ' for donating blood. The committee is grateful.' END,
    CASE WHEN v_names IS NULL
      THEN 'اس ہفتے خون کا عطیہ دینے والوں کا بہت شکریہ — کمیٹی مشکور ہے۔'
      ELSE 'شکریہ! ' || v_names || ' نے خون کا عطیہ دیا۔ کمیٹی مشکور ہے۔' END,
    true, -50
  ) RETURNING id INTO v_id;

  UPDATE blood_requests SET thanks_ticker_id = v_id WHERE id = p_request_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- A donor answering in their own portal.
CREATE OR REPLACE FUNCTION respond_to_blood_request(p_request_id uuid, p_response varchar) RETURNS void AS $$
BEGIN
  IF p_response NOT IN ('yes', 'no') THEN RAISE EXCEPTION 'Answer yes or no'; END IF;
  UPDATE blood_request_contacts
     SET response = p_response, responded_at = now()
   WHERE request_id = p_request_id
     AND blood_donor_id IN (SELECT id FROM blood_donors WHERE portal_user_id = current_portal_user_id());
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not contacted about this request'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION approve_blood_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_blood_request(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fulfil_blood_request(uuid, uuid[], date) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_blood_request_paused(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION post_blood_request_ticker(uuid, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION post_blood_thanks_ticker(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION respond_to_blood_request(uuid, varchar) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION approve_blood_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_blood_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION fulfil_blood_request(uuid, uuid[], date) TO authenticated;
GRANT EXECUTE ON FUNCTION set_blood_request_paused(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION post_blood_request_ticker(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION post_blood_thanks_ticker(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION respond_to_blood_request(uuid, varchar) TO authenticated;
