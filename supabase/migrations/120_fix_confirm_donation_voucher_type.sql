-- Migration 120: Fix confirm_donation() — it called next_voucher_no() with
-- the voucher *prefix* ('DP-INC-V') instead of the voucher_type key
-- ('income'). voucher_counters is keyed by (system, voucher_type); the
-- prefix is a separate column next_voucher_no() looks up internally. Caught
-- live via a real accountant session in /admin/donors ("No voucher counter
-- for donors_projects/DP-INC-V").

CREATE OR REPLACE FUNCTION confirm_donation(p_donor_id uuid, p_edits jsonb) RETURNS jsonb AS $$
DECLARE
  v_donor donors%ROWTYPE;
  v_account_id uuid;
  v_account_no varchar;
  v_voucher_no varchar;
  v_admin_id uuid := current_admin_user_id();
BEGIN
  IF NOT can_access_system('donors_projects') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to confirm donations';
  END IF;

  UPDATE donors SET
    name = COALESCE(p_edits->>'name', name),
    name_ur = COALESCE(p_edits->>'name_ur', name_ur),
    phone = COALESCE(p_edits->>'phone', phone),
    father_husband_name = COALESCE(p_edits->>'father_husband_name', father_husband_name),
    whatsapp_number = COALESCE(p_edits->>'whatsapp_number', whatsapp_number),
    donor_type = COALESCE(p_edits->>'donor_type', donor_type),
    amount_pkr = COALESCE((p_edits->>'amount_pkr')::decimal, amount_pkr),
    date = COALESCE((p_edits->>'date')::date, date),
    payment_method = COALESCE(p_edits->>'payment_method', payment_method),
    project_id = CASE WHEN p_edits ? 'project_id' THEN NULLIF(p_edits->>'project_id', '')::uuid ELSE project_id END,
    is_anonymous = COALESCE((p_edits->>'is_anonymous')::boolean, is_anonymous),
    notes = COALESCE(p_edits->>'notes', notes),
    is_verified = true, confirmed_at = now(), confirmed_by = v_admin_id
  WHERE id = p_donor_id
  RETURNING * INTO v_donor;

  IF NOT FOUND THEN RAISE EXCEPTION 'Donor not found'; END IF;

  v_account_id := ensure_donor_account(v_donor.name, v_donor.phone);
  SELECT donor_account_no INTO v_account_no FROM accounts WHERE id = v_account_id;
  IF v_account_no IS NULL THEN
    v_account_no := next_donor_account_no();
    UPDATE accounts SET donor_account_no = v_account_no WHERE id = v_account_id;
  END IF;

  v_voucher_no := v_donor.voucher_no;
  IF v_voucher_no IS NULL THEN
    v_voucher_no := next_voucher_no('donors_projects', 'income');
    UPDATE donors SET voucher_no = v_voucher_no WHERE id = p_donor_id;
  END IF;

  RETURN jsonb_build_object(
    'donor_id', v_donor.id, 'name', v_donor.name, 'amount_pkr', v_donor.amount_pkr,
    'account_no', v_account_no, 'voucher_no', v_voucher_no
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION confirm_donation(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_donation(uuid, jsonb) TO authenticated;
