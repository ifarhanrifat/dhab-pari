-- Migration 236: one donor action — name a child or student, or join the
-- shared pool — instead of two systems that never learned about each other.
--
-- ═════════════════════════════════════════════════════════════════════════
-- What this replaces
-- ═════════════════════════════════════════════════════════════════════════
-- kafalat_shares (migration 211) let a donor claim a percentage of one named
-- child. Investigated end to end while building this: it had no way to
-- actually confirm a payment arrived. A row could sit at status='pledged'
-- forever — no RPC, no admin action anywhere in the codebase ever moved it to
-- 'active'. It was also never reconciled against the measuring account
-- (migration 230), so a child fully named-sponsored still showed as fully
-- needed in the pool — asking donors to help fund a child who no longer
-- needed it. Confirmed against live: both tables are empty, so there is
-- nothing to migrate and nothing to lose by retiring the write path cleanly.
--
-- The fix is not to patch kafalat_shares — it is to stop having two systems.
-- A donor now does exactly one thing: choose an amount, choose one-time or
-- recurring, and choose who it's for — a specific child, a specific Wazifa
-- student, or the shared pool with no name attached. All three run through
-- the identical announce → confirm → credit-the-measuring-account pipeline
-- already built and proven in migration 231. Because there is only one path
-- money can take, there is no longer a way for the two figures to disagree —
-- naming a child and joining the shared pool are the same action with a
-- different target, not two systems that can drift apart.
--
-- kafalat_shares is left in place, untouched, and simply stops being written
-- to by anything built from here on. Nothing reads from it either after this
-- migration's UI changes land.

ALTER TABLE pool_commitments
  ADD COLUMN IF NOT EXISTS kafalat_child_id uuid REFERENCES kafalat_children(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wazifa_student_id uuid REFERENCES wazifa_students(id) ON DELETE SET NULL,
  ADD CONSTRAINT pool_commitments_one_target
    CHECK (NOT (kafalat_child_id IS NOT NULL AND wazifa_student_id IS NOT NULL));

ALTER TABLE pool_payments
  ADD COLUMN IF NOT EXISTS kafalat_child_id uuid REFERENCES kafalat_children(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wazifa_student_id uuid REFERENCES wazifa_students(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pool_commitments_child_idx ON pool_commitments(kafalat_child_id) WHERE kafalat_child_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pool_commitments_student_idx ON pool_commitments(wazifa_student_id) WHERE wazifa_student_id IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- Announcing, with an optional name attached
-- ═════════════════════════════════════════════════════════════════════════
-- Re-declared from migration 231 with the target added. Everything else —
-- the minimum, the recurring-commitment reuse, the one-announcement-per-month
-- guard — is unchanged.
CREATE OR REPLACE FUNCTION pool_announce(
  p_pool_id uuid, p_amount decimal, p_recurring boolean,
  p_funded_by varchar DEFAULT 'sadqa', p_show_name_publicly boolean DEFAULT false,
  p_kafalat_child_id uuid DEFAULT NULL, p_wazifa_student_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  pl support_pools%ROWTYPE; u portal_users%ROWTYPE;
  v_commitment_id uuid; v_month date; v_id uuid;
  v_min decimal;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That pool is not open.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO u FROM portal_users WHERE id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Please sign in first.' USING ERRCODE = 'P0001'; END IF;

  -- A name can only be attached to the pool it actually belongs to — naming
  -- a Wazifa student on the Kafalat pool would credit the wrong measuring
  -- account entirely.
  IF p_kafalat_child_id IS NOT NULL THEN
    IF pl.kind <> 'kafalat' THEN
      RAISE EXCEPTION 'A child can only be named on the Kafalat pool.' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM kafalat_children WHERE id = p_kafalat_child_id AND status = 'active') THEN
      RAISE EXCEPTION 'That child is not currently active in Kafalat.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF p_wazifa_student_id IS NOT NULL THEN
    IF pl.kind <> 'wazifa' THEN
      RAISE EXCEPTION 'A student can only be named on the Taleemi Wazifa pool.' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wazifa_awards WHERE student_id = p_wazifa_student_id AND status = 'active') THEN
      RAISE EXCEPTION 'That student does not have an active award right now.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_min := pl.min_share_pkr;
  IF p_amount < v_min THEN
    RAISE EXCEPTION 'The smallest amount for this pool is Rs %.',
      trim(to_char(v_min, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  IF p_recurring THEN
    SELECT id INTO v_commitment_id FROM pool_commitments
     WHERE pool_id = p_pool_id AND portal_user_id = u.id AND status IN ('active', 'lapsed');

    IF v_commitment_id IS NULL THEN
      INSERT INTO pool_commitments (pool_id, donor_name, donor_name_ur, donor_phone, portal_user_id,
                                    monthly_amount_pkr, funded_by, kafalat_child_id, wazifa_student_id)
      VALUES (p_pool_id, u.full_name, u.name_ur, u.mobile, u.id, p_amount, p_funded_by,
              p_kafalat_child_id, p_wazifa_student_id)
      RETURNING id INTO v_commitment_id;
    ELSE
      IF EXISTS (SELECT 1 FROM pool_commitments
                  WHERE id = v_commitment_id AND monthly_amount_pkr <> p_amount) THEN
        RAISE EXCEPTION
          'Your standing amount for this pool is already set. Change it from "My monthly shares" first if you want a different figure.'
          USING ERRCODE = 'P0001';
      END IF;
      -- Who it's named for can change between months (a sponsor may finish
      -- with one child and pick up another); the amount cannot.
      UPDATE pool_commitments
         SET status = 'active', lapsed_at = NULL, updated_at = now(),
             kafalat_child_id = p_kafalat_child_id, wazifa_student_id = p_wazifa_student_id
       WHERE id = v_commitment_id;
    END IF;
  ELSE
    v_commitment_id := NULL;
  END IF;

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, is_one_time,
                             status, announced_by_portal_user_id, announced_at, show_name_publicly,
                             kafalat_child_id, wazifa_student_id)
  VALUES (p_pool_id, v_commitment_id, v_month, p_amount, NOT p_recurring,
          'announced', u.id, now(), p_show_name_publicly, p_kafalat_child_id, p_wazifa_student_id)
  ON CONFLICT (commitment_id, for_month) WHERE status <> 'cancelled' AND commitment_id IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This month is already announced for this pool.' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('payment_id', v_id, 'commitment_id', v_commitment_id,
                            'month', v_month, 'position', pool_position(p_pool_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_announce(uuid, decimal, boolean, varchar, boolean, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_announce(uuid, decimal, boolean, varchar, boolean, uuid, uuid) TO authenticated;

-- Recurring re-announcement carries the same name forward automatically —
-- a sponsor who named a child in August is still naming that child in
-- September without doing anything.
CREATE OR REPLACE FUNCTION pool_announce_recurring_month() RETURNS jsonb AS $$
DECLARE v_month date; v_count int;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, is_one_time,
                             status, announced_by_portal_user_id, announced_at,
                             kafalat_child_id, wazifa_student_id)
  SELECT c.pool_id, c.id, v_month, c.monthly_amount_pkr, false,
         'announced', c.portal_user_id, now(), c.kafalat_child_id, c.wazifa_student_id
    FROM pool_commitments c
   WHERE c.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM pool_payments p
                      WHERE p.commitment_id = c.id AND p.for_month = v_month AND p.status <> 'cancelled')
  ON CONFLICT (commitment_id, for_month) WHERE status <> 'cancelled' AND commitment_id IS NOT NULL
    DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('announced', v_count, 'month', v_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- Confirming — the credit lands on the shared measuring account either way,
-- and on the named child or student's own account when one was chosen
-- ═════════════════════════════════════════════════════════════════════════
-- This is the whole fix. A named pledge and a shared pledge now run through
-- the exact same function, so the measuring account cannot be told about one
-- and not the other — there is only one place this ever happens.
CREATE OR REPLACE FUNCTION pool_post_confirmed_payment(
  p_pool_id uuid, p_commitment_id uuid, p_donor_name varchar, p_donor_name_ur varchar,
  p_donor_phone varchar, p_is_anonymous boolean, p_amount decimal, p_method varchar,
  p_portal_user_id uuid, p_month date, p_note text,
  p_kafalat_child_id uuid DEFAULT NULL, p_wazifa_student_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE pl support_pools%ROWTYPE; v_donor_id uuid; v_year varchar; v_child_name varchar;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id;

  v_child_name := CASE
    WHEN p_kafalat_child_id IS NOT NULL THEN
      (SELECT ' — for ' || first_name || ' (' || code || ')' FROM kafalat_children WHERE id = p_kafalat_child_id)
    WHEN p_wazifa_student_id IS NOT NULL THEN
      (SELECT ' — for ' || full_name || ' (' || code || ')' FROM wazifa_students WHERE id = p_wazifa_student_id)
    ELSE '' END;

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified,
                      payment_method, is_anonymous, fund_type, portal_user_id,
                      payment_status, notes, submitted_via)
  VALUES (p_donor_name, p_donor_name_ur, p_donor_phone, p_amount,
          (now() AT TIME ZONE 'Asia/Karachi')::date, true, p_method, p_is_anonymous,
          pl.fund_type, p_portal_user_id, 'paid',
          pl.name || COALESCE(v_child_name, '') || ' — ' || to_char(p_month, 'Mon YYYY')
            || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  IF p_commitment_id IS NOT NULL THEN
    UPDATE pool_commitments SET status = 'active', lapsed_at = NULL, updated_at = now()
     WHERE id = p_commitment_id AND status = 'lapsed';
  END IF;

  -- kafalat_current_year() is the shared Punjab-school-year boundary
  -- (April–March), used by both programmes' academic_year fields.
  IF pl.kind = 'kafalat' THEN
    v_year := kafalat_current_year();
    PERFORM kafalat_post_requirement_delta(v_year, -p_amount,
      p_donor_name || ' confirmed — ' || to_char(p_month, 'Mon YYYY'), p_kafalat_child_id);
  ELSIF pl.kind = 'wazifa' THEN
    v_year := kafalat_current_year();
    PERFORM wazifa_post_requirement_delta(v_year, -p_amount,
      p_donor_name || ' confirmed — ' || to_char(p_month, 'Mon YYYY'), p_wazifa_student_id);
  END IF;

  RETURN jsonb_build_object('donor_id', v_donor_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION pool_post_confirmed_payment(uuid, uuid, varchar, varchar, varchar, boolean, decimal, varchar, uuid, date, text, uuid, uuid) TO authenticated;

-- pool_confirm_payment and pool_record_payment both call
-- pool_post_confirmed_payment — re-declared only to pass the announcement's
-- own kafalat_child_id / wazifa_student_id through, which is the whole reason
-- this needed touching.
CREATE OR REPLACE FUNCTION pool_confirm_payment(p_payment_id uuid, p_method varchar DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  p pool_payments%ROWTYPE; pl support_pools%ROWTYPE;
  c pool_commitments%ROWTYPE; v_donor_name varchar; v_donor_name_ur varchar; v_donor_phone varchar;
  v_anon boolean; v_portal_user_id uuid; v_posted jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM pool_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF p.status <> 'announced' THEN
    RAISE EXCEPTION 'This is already %.', p.status USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO pl FROM support_pools WHERE id = p.pool_id;

  IF p.commitment_id IS NOT NULL THEN
    SELECT * INTO c FROM pool_commitments WHERE id = p.commitment_id;
    v_donor_name := c.donor_name; v_donor_name_ur := c.donor_name_ur; v_donor_phone := c.donor_phone;
    v_anon := c.is_anonymous; v_portal_user_id := c.portal_user_id;
  ELSE
    SELECT full_name, name_ur, mobile INTO v_donor_name, v_donor_name_ur, v_donor_phone
      FROM portal_users WHERE id = p.announced_by_portal_user_id;
    v_anon := false; v_portal_user_id := p.announced_by_portal_user_id;
  END IF;

  v_posted := pool_post_confirmed_payment(p.pool_id, p.commitment_id, v_donor_name, v_donor_name_ur,
    v_donor_phone, v_anon, p.amount_pkr, COALESCE(p_method, p.method, 'bank'), v_portal_user_id,
    p.for_month, NULL, p.kafalat_child_id, p.wazifa_student_id);

  UPDATE pool_payments
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
         donor_id = (v_posted->>'donor_id')::uuid,
         method = COALESCE(p_method, method, 'bank')
   WHERE id = p_payment_id;

  RETURN jsonb_build_object('donor_id', v_posted->>'donor_id', 'amount', p.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION pool_record_payment(
  p_commitment_id uuid, p_amount decimal, p_method varchar,
  p_for_month date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c pool_commitments%ROWTYPE; v_month date; v_id uuid; v_posted jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM pool_commitments WHERE id = p_commitment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commitment not found' USING ERRCODE = 'P0001'; END IF;

  v_month := COALESCE(date_trunc('month', p_for_month)::date,
                      date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date);

  v_posted := pool_post_confirmed_payment(c.pool_id, p_commitment_id, c.donor_name, c.donor_name_ur,
    c.donor_phone, c.is_anonymous, p_amount, p_method, c.portal_user_id, v_month, p_note,
    c.kafalat_child_id, c.wazifa_student_id);

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, method,
                             donor_id, note, created_by, status, confirmed_at, confirmed_by,
                             kafalat_child_id, wazifa_student_id)
  VALUES (c.pool_id, p_commitment_id, v_month, p_amount, p_method,
          (v_posted->>'donor_id')::uuid, p_note, current_admin_user_id(),
          'confirmed', now(), current_admin_user_id(), c.kafalat_child_id, c.wazifa_student_id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('for_month', v_month, 'amount', p_amount,
                            'donor_id', v_posted->>'donor_id', 'payment_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- What a donor sees when choosing who it's for
-- ═════════════════════════════════════════════════════════════════════════
-- Every active child, with what the rate card says they need this year and
-- how much of that is already named to them — informational, never a hard
-- cap. Over-funding one named child is not a bug: the surplus simply reduces
-- the shared measuring account faster, which is money the group still
-- needed, just arriving with a name on it.
CREATE OR REPLACE FUNCTION kafalat_children_for_naming() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'code', c.code, 'first_name', c.first_name, 'first_name_ur', c.first_name_ur,
    'current_class', c.current_class, 'is_orphan', c.is_orphan,
    'photo_url', CASE WHEN c.photo_consent AND NOT c.do_not_display THEN c.photo_url ELSE NULL END,
    'this_year_requirement', (SELECT (kafalat_generate_requirement(c.id, kafalat_current_year())->>'this_year_requirement')::decimal),
    'already_named', COALESCE((
      SELECT SUM(p.amount_pkr) FROM pool_payments p
       WHERE p.kafalat_child_id = c.id AND p.status = 'confirmed'
         AND p.for_month >= date_trunc('year', (now() AT TIME ZONE 'Asia/Karachi')::date) - interval '9 months'
    ), 0)
  ) ORDER BY c.code), '[]'::jsonb)
  FROM kafalat_children c WHERE c.status = 'active' AND NOT c.do_not_display;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION kafalat_children_for_naming() TO anon, authenticated;

CREATE OR REPLACE FUNCTION wazifa_students_for_naming() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'student_id', s.id, 'code', s.code, 'full_name', s.full_name,
    'institution', ap.institution, 'programme', ap.programme, 'level', ap.level,
    'awarded_amount', a.awarded_amount_pkr, 'is_loan', a.is_loan,
    'already_named', COALESCE((
      SELECT SUM(p.amount_pkr) FROM pool_payments p
       WHERE p.wazifa_student_id = s.id AND p.status = 'confirmed'
    ), 0)
  ) ORDER BY s.code), '[]'::jsonb)
  FROM wazifa_awards a
  JOIN wazifa_students s ON s.id = a.student_id
  JOIN wazifa_applications ap ON ap.id = a.application_id
  WHERE a.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_students_for_naming() TO anon, authenticated;

-- ── my_pool_commitments / my_pool_announcements now say who it's for ────
CREATE OR REPLACE FUNCTION my_pool_commitments() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'pool', p.name, 'pool_ur', p.name_ur, 'pool_id', p.id,
    'monthly_amount', c.monthly_amount_pkr, 'status', c.status,
    'funded_by', c.funded_by, 'started_on', c.started_on,
    'named_child', (SELECT first_name FROM kafalat_children WHERE id = c.kafalat_child_id),
    'named_student', (SELECT full_name FROM wazifa_students WHERE id = c.wazifa_student_id),
    'paid_this_month', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                                  WHERE commitment_id = c.id AND status = 'confirmed'
                                    AND for_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date), 0),
    'announced_this_month', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                                  WHERE commitment_id = c.id AND status = 'announced'
                                    AND for_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date), 0),
    'months_given', (SELECT count(DISTINCT for_month) FROM pool_payments
                      WHERE commitment_id = c.id AND status = 'confirmed'),
    'total_given', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                              WHERE commitment_id = c.id AND status = 'confirmed'), 0)
  ) ORDER BY c.created_at DESC), '[]'::jsonb)
  FROM pool_commitments c JOIN support_pools p ON p.id = c.pool_id
  WHERE c.portal_user_id = current_portal_user_id()
    AND c.status <> 'cancelled';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_pool_announcements() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'pool_id', p.pool_id, 'pool', pl.name, 'pool_ur', pl.name_ur,
    'amount', p.amount_pkr, 'is_one_time', p.is_one_time, 'month', p.for_month,
    'status', p.status, 'has_proof', p.proof_url IS NOT NULL,
    'show_name_publicly', p.show_name_publicly, 'announced_at', p.announced_at,
    'named_child', (SELECT first_name FROM kafalat_children WHERE id = p.kafalat_child_id),
    'named_student', (SELECT full_name FROM wazifa_students WHERE id = p.wazifa_student_id)
  ) ORDER BY p.announced_at DESC)
  , '[]'::jsonb)
  FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
  WHERE p.announced_by_portal_user_id = current_portal_user_id()
    AND p.status IN ('announced', 'confirmed')
    AND p.announced_at > now() - interval '2 years';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_pool_commitments() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION my_pool_announcements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_pool_commitments() TO authenticated;
GRANT EXECUTE ON FUNCTION my_pool_announcements() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Full automation, closing the gap for Kafalat too
-- ═════════════════════════════════════════════════════════════════════════
-- Confirmed by driving a named pledge end to end: a child's own subsidiary
-- ledger account (ensure_kafalat_child_account, migration 218) only ever
-- got created lazily, the first time a kafalat_payment voucher happened to
-- be posted against them — never at approval. A donor naming a child and
-- being confirmed the same day would credit the shared measuring account
-- correctly but leave that child's own account not existing yet, so "how
-- much has been given for this specific child" had nowhere to be recorded.
-- kafalat_approve_child() now creates it eagerly, the same day the
-- committee says yes — matching what this migration's sibling fix did for
-- Wazifa in migration 235.
CREATE OR REPLACE FUNCTION kafalat_approve_child(p_child_id uuid) RETURNS jsonb AS $$
DECLARE
  c kafalat_children%ROWTYPE; v_level int; v_min int; v_max int;
  v_year varchar; v_req jsonb; v_this_year decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Child not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT c.guardian_consent_signed THEN
    RAISE EXCEPTION 'Guardian consent has not been signed yet.' USING ERRCODE = 'P0001';
  END IF;

  v_level := class_to_level(c.current_class);
  SELECT value::int INTO v_min FROM site_settings WHERE key = 'kafalat_min_class';
  SELECT value::int INTO v_max FROM site_settings WHERE key = 'kafalat_max_class';
  IF v_level IS NULL OR v_level < COALESCE(v_min, 1) OR v_level > COALESCE(v_max, 10) THEN
    RAISE EXCEPTION
      'Mushtarka Kafalat covers class % to class %. This child''s class (%) is outside that — for a student past class %, Taleemi Wazifa is the right programme.',
      COALESCE(v_min,1), COALESCE(v_max,10), COALESCE(c.current_class, 'not set'), COALESCE(v_max,10)
      USING ERRCODE = 'P0001';
  END IF;

  v_year := kafalat_current_year();

  UPDATE kafalat_children
     SET status = 'active', joined_on = COALESCE(joined_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
         updated_at = now()
   WHERE id = p_child_id;

  -- The child's own subsidiary account, created the day approval happens —
  -- not the day the first payment happens to land.
  PERFORM ensure_kafalat_child_account(p_child_id);

  v_req := kafalat_generate_requirement(p_child_id, v_year);
  v_this_year := (v_req->>'this_year_requirement')::decimal;

  PERFORM kafalat_post_requirement_delta(v_year, v_this_year,
    c.first_name || ' (' || c.code || ') approved — ' || (v_req->>'months_remaining') || ' months left in ' || v_year,
    p_child_id);

  PERFORM kafalat_schedule_uniforms(p_child_id, v_year);

  RETURN v_req || jsonb_build_object('child_code', c.code);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
