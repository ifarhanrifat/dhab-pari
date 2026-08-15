-- Migration 244: a donor can sponsor more than one child (or student, or
-- object) at once, each its own standing monthly amount.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why "one commitment per pool per donor" was wrong
-- ═════════════════════════════════════════════════════════════════════════
-- pool_announce() has always reused whichever commitment already existed
-- for (portal_user_id, pool_id), regardless of who it was named for — the
-- right call when a pool had no naming at all (migration 231), but wrong
-- since migration 236 added naming: a donor sponsoring a second child would
-- silently retarget their first child's commitment instead of creating a
-- second one. Confirmed directly: this is exactly what produced the "why
-- did my pledge lose its name" reports.
--
-- The fix matches on the target too, using IS NOT DISTINCT FROM so NULL
-- (the shared pool, no name) matches NULL correctly. Re-announcing to the
-- same child now adjusts that child's own commitment, same as before;
-- announcing to a different child (or the shared pool) now creates its own
-- separate row instead of overwriting.
CREATE OR REPLACE FUNCTION pool_announce(
  p_pool_id uuid, p_amount decimal, p_recurring boolean,
  p_funded_by varchar DEFAULT 'sadqa', p_show_name_publicly boolean DEFAULT false,
  p_kafalat_child_id uuid DEFAULT NULL, p_wazifa_student_id uuid DEFAULT NULL,
  p_sadqa_object_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  pl support_pools%ROWTYPE; u portal_users%ROWTYPE;
  v_commitment_id uuid; v_month date; v_id uuid; v_min decimal;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That pool is not open.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO u FROM portal_users WHERE id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Please sign in first.' USING ERRCODE = 'P0001'; END IF;

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
  IF p_sadqa_object_id IS NOT NULL THEN
    IF pl.code <> 'POOL-SDQ' THEN
      RAISE EXCEPTION 'An object can only be named on the shared Sadqa upkeep pool.' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM sadqa_objects
                    WHERE id = p_sadqa_object_id AND maintenance_mode = 'committee'
                      AND status IN ('installed', 'in_service', 'needs_repair')) THEN
      RAISE EXCEPTION 'That object is not currently under committee-maintained upkeep.' USING ERRCODE = 'P0001';
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
     WHERE pool_id = p_pool_id AND portal_user_id = u.id AND status IN ('active', 'lapsed')
       AND kafalat_child_id IS NOT DISTINCT FROM p_kafalat_child_id
       AND wazifa_student_id IS NOT DISTINCT FROM p_wazifa_student_id
       AND sadqa_object_id IS NOT DISTINCT FROM p_sadqa_object_id;

    IF v_commitment_id IS NULL THEN
      INSERT INTO pool_commitments (pool_id, donor_name, donor_name_ur, donor_phone, portal_user_id,
                                    monthly_amount_pkr, funded_by, kafalat_child_id, wazifa_student_id,
                                    sadqa_object_id)
      VALUES (p_pool_id, u.full_name, u.name_ur, u.mobile, u.id, p_amount, p_funded_by,
              p_kafalat_child_id, p_wazifa_student_id, p_sadqa_object_id)
      RETURNING id INTO v_commitment_id;
    ELSE
      -- Same target as before: this is an adjustment to that one
      -- commitment, not a new pledge — the amount only moves at the
      -- donor's own hand (pool_change_my_share), never silently here.
      IF EXISTS (SELECT 1 FROM pool_commitments
                  WHERE id = v_commitment_id AND monthly_amount_pkr <> p_amount) THEN
        RAISE EXCEPTION
          'You already have a monthly share for this. Change it from "My monthly shares" first if you want a different amount.'
          USING ERRCODE = 'P0001';
      END IF;
      UPDATE pool_commitments SET status = 'active', lapsed_at = NULL, updated_at = now()
       WHERE id = v_commitment_id;
    END IF;
  ELSE
    v_commitment_id := NULL;
  END IF;

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, is_one_time,
                             status, announced_by_portal_user_id, announced_at, show_name_publicly,
                             kafalat_child_id, wazifa_student_id, sadqa_object_id)
  VALUES (p_pool_id, v_commitment_id, v_month, p_amount, NOT p_recurring,
          'announced', u.id, now(), p_show_name_publicly, p_kafalat_child_id, p_wazifa_student_id,
          p_sadqa_object_id)
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

-- ═════════════════════════════════════════════════════════════════════════
-- A donor-facing view of what their money actually bought — the same
-- record the committee sees, minus the parts that are the committee's own
-- business (who signed, the slip photo, internal notes).
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION kafalat_child_public_expense_summary(p_child_id uuid, p_academic_year varchar DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  c kafalat_children%ROWTYPE; v_year varchar := COALESCE(p_academic_year, kafalat_current_year());
  v_lines jsonb; v_total decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND status = 'active' AND NOT do_not_display;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'paid_on'), '[]'::jsonb), COALESCE(SUM((x->>'amount')::decimal), 0)
    INTO v_lines, v_total
  FROM (
    SELECT jsonb_build_object('category', fp.category, 'amount', fp.amount_pkr, 'paid_on', fp.paid_on) AS x
    FROM kafalat_fee_payments fp
    WHERE fp.child_id = p_child_id AND fp.paid_on BETWEEN kafalat_year_starts(v_year) AND kafalat_year_ends(v_year)
    UNION ALL
    SELECT jsonb_build_object('category', 'uniform', 'amount', u.amount_pkr, 'paid_on', u.issued_on) AS x
    FROM kafalat_uniform_issues u
    WHERE u.child_id = p_child_id AND u.academic_year = v_year AND u.status = 'issued'
    UNION ALL
    SELECT jsonb_build_object('category', d.category, 'amount', d.amount_pkr, 'paid_on', d.paid_on) AS x
    FROM kafalat_disbursements d
    WHERE d.child_id = p_child_id AND d.status = 'paid'
      AND d.month BETWEEN kafalat_year_starts(v_year) AND kafalat_year_ends(v_year)
  ) rows;

  RETURN jsonb_build_object(
    'child_name', c.first_name, 'academic_year', v_year, 'lines', v_lines, 'total_spent', v_total,
    'this_year_requirement', kafalat_this_year_requirement(p_child_id, v_year)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_child_public_expense_summary(uuid, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kafalat_child_public_expense_summary(uuid, varchar) TO anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- The stats a donor actually wants at the top of the page: how many
-- children, how far behind or ahead the pool is this month, at a glance.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION kafalat_public_dashboard() RETURNS jsonb AS $$
DECLARE v_meas jsonb;
BEGIN
  v_meas := kafalat_measuring_position();
  RETURN jsonb_build_object(
    'children_active', (SELECT count(*) FROM kafalat_children WHERE status = 'active' AND NOT do_not_display),
    'monthly_target', v_meas->>'monthly_target',
    'outstanding', v_meas->>'outstanding',
    'confirmed', v_meas->>'confirmed',
    'required', v_meas->>'required',
    'on_track', (COALESCE((v_meas->>'confirmed')::decimal, 0) >= COALESCE((v_meas->>'required')::decimal, 0) * 0.9)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_public_dashboard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kafalat_public_dashboard() TO anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Extending the general recurring/statement pages to also understand Kafalat
-- ═════════════════════════════════════════════════════════════════════════
-- What /portal/recurring needs: every active or lapsed pool_commitments row
-- for this donor, in the same shape a recurring_schedules row already has,
-- so the two can sit in one merged list.
CREATE OR REPLACE FUNCTION my_pool_recurring_lines() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'source', 'pool', 'amount_pkr', c.monthly_amount_pkr, 'is_active', c.status = 'active',
    'particular', pl.name || COALESCE(
      (SELECT ' — ' || first_name FROM kafalat_children WHERE id = c.kafalat_child_id),
      (SELECT ' — ' || full_name FROM wazifa_students WHERE id = c.wazifa_student_id),
      (SELECT ' — ' || item_name FROM sadqa_objects WHERE id = c.sadqa_object_id),
      ''
    ),
    'pool_code', pl.code
  ) ORDER BY c.created_at DESC), '[]'::jsonb)
  FROM pool_commitments c JOIN support_pools pl ON pl.id = c.pool_id
  WHERE c.portal_user_id = current_portal_user_id() AND c.status IN ('active', 'lapsed');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_pool_recurring_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_pool_recurring_lines() TO authenticated;

-- What /portal/statement needs: every announced (not yet confirmed)
-- pool_payments row for this donor, in the same shape a "pledge" already
-- has, so "Pay Now" / attach-proof works from the one page.
CREATE OR REPLACE FUNCTION my_pool_pending_payments() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'source', 'pool', 'amount_pkr', p.amount_pkr, 'date', p.announced_at,
    'has_proof', p.proof_url IS NOT NULL,
    'particular', pl.name || COALESCE(
      (SELECT ' — ' || first_name FROM kafalat_children WHERE id = p.kafalat_child_id),
      (SELECT ' — ' || full_name FROM wazifa_students WHERE id = p.wazifa_student_id),
      (SELECT ' — ' || item_name FROM sadqa_objects WHERE id = p.sadqa_object_id),
      ''
    )
  ) ORDER BY p.announced_at DESC), '[]'::jsonb)
  FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
  WHERE p.announced_by_portal_user_id = current_portal_user_id() AND p.status = 'announced';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_pool_pending_payments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_pool_pending_payments() TO authenticated;

-- The donor's own action from /portal/statement's "Pay Now" modal — same
-- role as submit_pledge_payment(), for a pool_payments row instead of a
-- donors row.
CREATE OR REPLACE FUNCTION pool_submit_pledge_payment(p_payment_id uuid, p_proof_url text, p_method varchar)
RETURNS jsonb AS $$
DECLARE p pool_payments%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pool_payments WHERE id = p_payment_id AND announced_by_portal_user_id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.' USING ERRCODE = 'P0001'; END IF;
  IF p.status <> 'announced' THEN RAISE EXCEPTION 'Already confirmed.' USING ERRCODE = 'P0001'; END IF;
  UPDATE pool_payments SET proof_url = p_proof_url, method = p_method WHERE id = p_payment_id;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_submit_pledge_payment(uuid, text, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_submit_pledge_payment(uuid, text, varchar) TO authenticated;
