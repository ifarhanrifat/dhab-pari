-- Migration 240: every confirmed pool donation gets a real voucher number
-- and donor account number — the same way every other staff-entered
-- donation already does.
--
-- assign_donor_numbers_internal() (migration 157) is the established rule:
-- a donation entered directly as already-verified (not through the portal's
-- own announce -> confirm -> accountant-confirms-again path with its own
-- separate numbering) needs its voucher_no and the underlying account's
-- donor_account_no assigned explicitly, because the trigger that posts the
-- ledger entries doesn't do it on its own. /admin/donors's "Add Donor" and
-- run_recurring_schedule() both already call it. pool_post_confirmed_payment()
-- never did — every Kafalat, Wazifa and Sadqa pool donation confirmed since
-- migration 231 has been sitting with no voucher_no. Not a data-loss bug —
-- the ledger entries themselves are correct and were never wrong — but the
-- number the accountant actually looks for was always blank.
CREATE OR REPLACE FUNCTION pool_post_confirmed_payment(
  p_pool_id uuid, p_commitment_id uuid, p_donor_name varchar, p_donor_name_ur varchar,
  p_donor_phone varchar, p_is_anonymous boolean, p_amount decimal, p_method varchar,
  p_portal_user_id uuid, p_month date, p_note text,
  p_kafalat_child_id uuid DEFAULT NULL, p_wazifa_student_id uuid DEFAULT NULL,
  p_sadqa_object_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE pl support_pools%ROWTYPE; v_donor_id uuid; v_year varchar; v_named text;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id;

  v_named := CASE
    WHEN p_kafalat_child_id IS NOT NULL THEN
      (SELECT ' — for ' || first_name || ' (' || code || ')' FROM kafalat_children WHERE id = p_kafalat_child_id)
    WHEN p_wazifa_student_id IS NOT NULL THEN
      (SELECT ' — for ' || full_name || ' (' || code || ')' FROM wazifa_students WHERE id = p_wazifa_student_id)
    WHEN p_sadqa_object_id IS NOT NULL THEN
      (SELECT ' — for ' || item_name || ' (' || object_no || ')' FROM sadqa_objects WHERE id = p_sadqa_object_id)
    ELSE '' END;

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified,
                      payment_method, is_anonymous, fund_type, portal_user_id,
                      payment_status, notes, submitted_via)
  VALUES (p_donor_name, p_donor_name_ur, p_donor_phone, p_amount,
          (now() AT TIME ZONE 'Asia/Karachi')::date, true, p_method, p_is_anonymous,
          pl.fund_type, p_portal_user_id, 'paid',
          pl.name || COALESCE(v_named, '') || ' — ' || to_char(p_month, 'Mon YYYY')
            || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  -- Same rule every other staff-confirmed donation follows.
  PERFORM assign_donor_numbers_internal(v_donor_id);

  IF p_commitment_id IS NOT NULL THEN
    UPDATE pool_commitments SET status = 'active', lapsed_at = NULL, updated_at = now()
     WHERE id = p_commitment_id AND status = 'lapsed';
  END IF;

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

GRANT EXECUTE ON FUNCTION pool_post_confirmed_payment(uuid, uuid, varchar, varchar, varchar, boolean, decimal, varchar, uuid, date, text, uuid, uuid, uuid) TO authenticated;

-- Back-fill every pool donation already sitting without a number.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT d.id FROM donors d
    JOIN pool_payments p ON p.donor_id = d.id
    WHERE d.voucher_no IS NULL
  LOOP
    PERFORM assign_donor_numbers_internal(r.id);
  END LOOP;
END $$;
