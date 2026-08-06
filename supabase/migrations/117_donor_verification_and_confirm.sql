-- Migration 117: Verification gate for donations + the accountant's confirm
-- workflow. Until now trg_donor_ledger() posted to the ledger unconditionally
-- on insert — is_verified was a display flag only (fine while every donor
-- row was staff-entered and pre-verified). Migration 116 just turned on
-- public, unverified submissions — those must NOT hit the books until an
-- accountant has actually checked the bank/EasyPaisa/JazzCash record.

CREATE OR REPLACE FUNCTION trg_donor_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_project_title text;
  v_particular text;
BEGIN
  v_account_id := ensure_donor_account(NEW.name, NEW.phone);
  UPDATE accounts SET name_ur = NEW.name_ur WHERE id = v_account_id AND name_ur IS DISTINCT FROM NEW.name_ur;

  DELETE FROM ledger_entries WHERE reference_type = 'donation' AND reference_id = NEW.id;

  IF NOT NEW.is_verified THEN
    RETURN NEW;
  END IF;

  SELECT title INTO v_project_title FROM projects WHERE id = NEW.project_id;
  v_particular := 'Donation' || CASE WHEN v_project_title IS NOT NULL THEN ' - ' || v_project_title ELSE '' END;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'donors_projects' AND code = (CASE WHEN NEW.payment_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cash_account_id, NEW.date, v_particular, NEW.amount_pkr, 0, 'donation', NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS donor_ledger_trigger ON donors;
CREATE TRIGGER donor_ledger_trigger AFTER INSERT OR UPDATE OF amount_pkr, date, project_id, is_verified ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_donor_ledger();

-- confirm_donation(): the sole path that verifies a donation. Applies the
-- accountant's edits (full-form — a public submission may have typos or need
-- correction), flips is_verified (which fires the trigger above), and
-- assigns the donor's permanent account number + this donation's voucher
-- number on first confirmation only (never reassigned on re-confirm/edit).
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
    v_voucher_no := next_voucher_no('donors_projects', 'DP-INC-V');
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

-- Thank-you + instructions template, sent via wa.me after confirmation.
INSERT INTO message_templates (key, label, body) VALUES (
  'donor_donation_confirmed', 'Donation Confirmed (Thank You)',
  'Dhab Pari — Thank You %%name%%!' || chr(10) || chr(10) ||
  'Your donation of Rs. %%amount%% has been verified and recorded.' || chr(10) ||
  'Donor Account: %%account_no%%' || chr(10) ||
  'Project: %%project%%' || chr(10) || chr(10) ||
  'May Allah reward your generosity. JazakAllah Khair!'
) ON CONFLICT (key) DO NOTHING;
