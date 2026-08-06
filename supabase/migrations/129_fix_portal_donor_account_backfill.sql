-- Migration 129: portal_users.donor_account_id was only ever set once, at
-- signup (matching an EXISTING donor account by phone). A donor who
-- registers before their first donation gets NULL there, and nothing ever
-- backfilled it once confirm_donation() later created their account —
-- confirmed live: Muhammad Azan registered, donated Rs. 20,000, an
-- accountant verified it (voucher DP-INC-V-0004, account DNR-00005), and
-- his portal_users row still points nowhere, so /portal/statement shows
-- Rs. 0 forever. Two fixes: backfill every already-affected row, and make
-- confirm_donation() self-heal this going forward.

-- 1. One-time backfill: link every portal_users row with a NULL
-- donor_account_id to the matching donor account, keyed the same way
-- ensure_donor_account()/donor_key_for() already resolve identity
-- (phone if set, else name — mirrored here against mobile/whatsapp_number).
UPDATE portal_users pu
SET donor_account_id = a.id
FROM accounts a
WHERE pu.donor_account_id IS NULL
  AND a.type = 'donor' AND a.system = 'donors_projects'
  AND a.donor_key IN (lower(pu.mobile), lower(COALESCE(pu.whatsapp_number, '')));

-- 2. confirm_donation() now backfills the donor's portal_users row (if any,
-- and if not already linked) every time a donation is confirmed — full
-- body carried forward from migration 120, plus the new UPDATE at the end.
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

  -- Backfill the donor's own portal account, if they're registered and not
  -- already linked (self-healing the gap this migration was written for).
  UPDATE portal_users SET donor_account_id = v_account_id
  WHERE donor_account_id IS NULL
    AND (lower(mobile) = lower(COALESCE(v_donor.phone, '')) OR lower(COALESCE(whatsapp_number, '')) = lower(COALESCE(v_donor.phone, '')));

  RETURN jsonb_build_object(
    'donor_id', v_donor.id, 'name', v_donor.name, 'amount_pkr', v_donor.amount_pkr,
    'account_no', v_account_no, 'voucher_no', v_voucher_no
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
