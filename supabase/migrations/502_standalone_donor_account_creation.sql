-- Real gap found+fixed 2026-09-22: there was no way to create a donor
-- account without also recording a donation. ensure_donor_account()
-- (migration 007) has always existed as a standalone, idempotent building
-- block -- it just creates the ledger account row -- but the only two
-- callers were the donor_ledger_trigger (fires on a donation insert) and
-- assign_donor_numbers_internal (migration 157, also only ever called
-- right after a donation insert). So "add a new donor" always meant
-- filling in the full donation form (amount, cash/bank, project...) even
-- when the accountant just wanted to register someone before their first
-- gift. Rizwan asked for these to be genuinely separate: create the
-- account here, record their first donation later from the existing
-- donation-receiving feature on the transactions page.
--
-- accounts (type='donor') never had columns for the donor's own profile
-- fields (phone, donor_type, donor_location, etc.) -- that data has only
-- ever lived on individual donors rows (one per donation), sourced by
-- pickExistingDonor() via a live query for each donor's most recent
-- donation. Adding it here lets an account carry its own profile
-- independent of any donation ever existing -- existing donors (created
-- the old way) simply have these columns NULL on their account row until
-- their next donation; the frontend's existing donation-row lookup as a
-- fallback is untouched and still needed for exactly that case.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS phone varchar,
  ADD COLUMN IF NOT EXISTS whatsapp_number varchar,
  ADD COLUMN IF NOT EXISTS donor_type varchar,
  ADD COLUMN IF NOT EXISTS donor_location varchar,
  ADD COLUMN IF NOT EXISTS father_husband_name varchar;

CREATE OR REPLACE FUNCTION create_donor_account(
  p_name varchar, p_name_ur varchar, p_phone varchar, p_whatsapp_number varchar,
  p_donor_type varchar, p_donor_location varchar, p_father_husband_name varchar
) RETURNS jsonb AS $$
DECLARE
  v_account_id uuid;
  v_account_no varchar;
  v_donor_key varchar;
  v_dup_warning text;
BEGIN
  IF NOT can_access_system('donors_projects') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to create a donor account';
  END IF;
  IF COALESCE(TRIM(p_name), '') = '' THEN
    RAISE EXCEPTION 'Donor name is required';
  END IF;

  -- Advisory only, same duplicate rules the public donation form already
  -- uses (migration 115) -- staff get the final call, this just makes sure
  -- they're not creating "Muhammad Amir" a second time by accident when
  -- he's already account DNR-00042.
  v_dup_warning := check_donor_duplicate(p_name, p_father_husband_name, p_whatsapp_number, p_phone);

  v_account_id := ensure_donor_account(p_name, p_phone);

  UPDATE accounts SET
    name_ur = NULLIF(TRIM(COALESCE(p_name_ur, '')), ''),
    phone = NULLIF(TRIM(COALESCE(p_phone, '')), ''),
    whatsapp_number = NULLIF(TRIM(COALESCE(p_whatsapp_number, '')), ''),
    donor_type = NULLIF(TRIM(COALESCE(p_donor_type, '')), ''),
    donor_location = NULLIF(TRIM(COALESCE(p_donor_location, '')), ''),
    father_husband_name = NULLIF(TRIM(COALESCE(p_father_husband_name, '')), '')
  WHERE id = v_account_id
  RETURNING donor_key, donor_account_no INTO v_donor_key, v_account_no;

  IF v_account_no IS NULL THEN
    v_account_no := next_donor_account_no();
    UPDATE accounts SET donor_account_no = v_account_no WHERE id = v_account_id;
  END IF;

  RETURN jsonb_build_object(
    'account_id', v_account_id, 'donor_key', v_donor_key, 'donor_account_no', v_account_no,
    'duplicate_warning', v_dup_warning
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION create_donor_account(varchar, varchar, varchar, varchar, varchar, varchar, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_donor_account(varchar, varchar, varchar, varchar, varchar, varchar, varchar) TO authenticated;

-- Existing donor-picker lists (finance page, donors page) query `accounts`
-- directly for name/donor_key/donor_account_no already -- extend that
-- read to the new profile columns too, so a donor created here shows up
-- fully-detailed the moment they're picked, with no donation required
-- first.
