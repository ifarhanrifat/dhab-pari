-- Migration 272: wazifa_record_contribution() was crediting a student's own
-- subsidiary account twice for every single contribution.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Found while building my_wazifa_statement() (migration 271) — the very
-- first test payment through the new instalment path showed two identical
-- credit lines for one payment. Tracing it back, the same shape of bug was
-- already sitting in wazifa_record_contribution() since migration 235:
-- ═════════════════════════════════════════════════════════════════════════
--   1. It inserts a voucher with wazifa_student_id set. post_welfare_
--      voucher_legs() (migration 224) fires on that insert and posts a
--      credit to the student's own subsidiary account — that leg is
--      already done, automatically, the same way it is for every other
--      wazifa_student_id-carrying voucher.
--   2. It then calls wazifa_post_requirement_delta(..., aw.student_id) —
--      which, when given a student id, posts a *second* credit to that same
--      subsidiary account, on top of the one the trigger already posted.
--
-- The measuring account itself was never affected — wazifa_post_requirement_
-- delta() only posts there once regardless of the student id argument, and
-- that account is what every "how much has been raised" figure reads. What
-- was wrong was narrower: a student's own bank-statement-style ledger (the
-- thing this whole document was written to expose) would have shown them
-- as having paid double what they actually paid.
--
-- Checked against production before writing this: zero wazifa_contribution
-- vouchers have ever been posted there, so there is no historical entry to
-- correct — this is a forward-only fix, the same as catching a bug in code
-- that has not yet run.
--
-- wazifa_post_requirement_delta(p_academic_year, p_delta, p_particular)
-- already defaults p_student_id to NULL, which skips that second leg
-- entirely — the fix is simply not passing it, since the trigger already
-- covers that leg for any voucher that carries wazifa_student_id.
CREATE OR REPLACE FUNCTION wazifa_record_contribution(
  p_award_id uuid, p_amount decimal, p_method varchar, p_for_month date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; v_cash uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_receipt varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — student''s own monthly share'
      || COALESCE(' · ' || to_char(p_for_month, 'Mon YYYY'), '') || COALESCE(' · ' || p_note, ''),
    p_amount, v_cash, v_cash, st.full_name, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no, receipt_no INTO v_voucher_id, v_voucher_no, v_receipt;

  UPDATE wazifa_awards SET contributed_pkr = contributed_pkr + p_amount WHERE id = p_award_id;

  -- The measuring account only — the trigger fired by the insert above
  -- already posted the student's own subsidiary-account leg. This used to
  -- pass aw.student_id here too, which posted that same leg a second time.
  PERFORM wazifa_post_requirement_delta(aw.academic_year, -p_amount,
    st.full_name || ' contributed — ' || COALESCE(to_char(p_for_month, 'Mon YYYY'), to_char(now(), 'Mon YYYY')));

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
