-- Migration 157: manually-added donations ("Add Donor" on /admin/donors,
-- and staff-created recurring donation schedules) insert with
-- is_verified = true immediately — real ledger entries post right away via
-- trg_donor_ledger — but neither path ever assigned a voucher_no or a
-- donor_account_no, unlike every other document type in this app (bills,
-- purchases, vouchers, and donations that go through confirm_donation()).
-- Factor the number-assignment logic already proven in confirm_donation()
-- (117/120) into its own callable function instead of duplicating it a
-- third time.
--
-- Split into an unchecked internal version (for run_recurring_schedule
-- below, which runs on pg_cron with no admin session to check permissions
-- against) and a checked public wrapper (for the client-callable path from
-- "Add Donor") — same pattern as ensure_donor_account/next_voucher_no
-- (internal, no grants) vs confirm_donation (checked, granted to
-- authenticated).
CREATE OR REPLACE FUNCTION assign_donor_numbers_internal(p_donor_id uuid) RETURNS void AS $$
DECLARE
  v_donor donors%ROWTYPE;
  v_account_id uuid;
  v_account_no varchar;
BEGIN
  SELECT * INTO v_donor FROM donors WHERE id = p_donor_id;
  IF v_donor.id IS NULL THEN RETURN; END IF;

  v_account_id := ensure_donor_account(v_donor.name, v_donor.phone);
  SELECT donor_account_no INTO v_account_no FROM accounts WHERE id = v_account_id;
  IF v_account_no IS NULL THEN
    v_account_no := next_donor_account_no();
    UPDATE accounts SET donor_account_no = v_account_no WHERE id = v_account_id;
  END IF;

  IF v_donor.voucher_no IS NULL THEN
    UPDATE donors SET voucher_no = next_voucher_no('donors_projects', 'income') WHERE id = p_donor_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION assign_donor_numbers(p_donor_id uuid) RETURNS void AS $$
BEGIN
  IF NOT can_access_system('donors_projects') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to assign donor numbers';
  END IF;
  PERFORM assign_donor_numbers_internal(p_donor_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION assign_donor_numbers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assign_donor_numbers(uuid) TO authenticated;

-- Staff-created recurring donation schedules (run_recurring_schedule,
-- last defined in 125) insert with is_verified = true immediately for the
-- created_by_portal_user_id IS NULL case — same gap, fixed the same way
-- right here rather than via a second client round-trip. Portal-submitted
-- schedules still insert unverified and get their numbers from
-- confirm_donation() as before — untouched.
CREATE OR REPLACE FUNCTION run_recurring_schedule(p_schedule_id uuid) RETURNS void AS $$
DECLARE
  s recurring_schedules%ROWTYPE;
  v_new_id uuid;
  v_next timestamptz;
  v_due_date date;
  v_complaint record;
BEGIN
  SELECT * INTO s FROM recurring_schedules
  WHERE id = p_schedule_id AND is_active = true AND next_run_date <= now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  v_due_date := make_date(EXTRACT(YEAR FROM s.next_run_date)::int, EXTRACT(MONTH FROM s.next_run_date)::int, 7);

  IF s.schedule_type = 'bill' THEN
    INSERT INTO bills (consumer_id, month, year, amount_pkr, discount_amount, due_date, description, recurring_schedule_id)
    VALUES (s.consumer_id, EXTRACT(MONTH FROM s.next_run_date)::int, EXTRACT(YEAR FROM s.next_run_date)::int,
            s.amount_pkr, s.discount_amount, v_due_date, s.particular, s.id)
    ON CONFLICT (consumer_id, month, year) DO NOTHING
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL THEN
      FOR v_complaint IN
        SELECT id FROM complaints WHERE system = 'water_supply' AND consumer_id = s.consumer_id AND status != 'verified' AND waiver_active = true
      LOOP
        PERFORM apply_complaint_waiver_to_bill(v_new_id, v_complaint.id);
      END LOOP;
    END IF;

  ELSIF s.schedule_type = 'donation' THEN
    INSERT INTO donors (name, name_ur, phone, donor_type, amount_pkr, date, payment_method, project_id, is_verified, is_anonymous, recurring_schedule_id, submitted_via)
    VALUES (s.donor_name, s.donor_name_ur, s.donor_phone, s.donor_type, s.amount_pkr, s.next_run_date::date,
            s.payment_method, s.project_id, s.created_by_portal_user_id IS NULL, false, s.id,
            CASE WHEN s.created_by_portal_user_id IS NULL THEN 'staff' ELSE 'public' END)
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL AND s.created_by_portal_user_id IS NULL THEN
      PERFORM assign_donor_numbers_internal(v_new_id);
    END IF;

  ELSIF s.schedule_type = 'expense' THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, recurring_schedule_id)
    VALUES (s.system, 'expense', s.next_run_date::date, COALESCE(s.particular, 'Recurring expense'), s.amount_pkr,
            s.from_account_id, s.to_account_id, s.party_name, s.id)
    RETURNING id INTO v_new_id;
  END IF;

  v_next := CASE s.frequency
    WHEN 'every_minute' THEN s.next_run_date + INTERVAL '1 minute'
    WHEN 'daily' THEN s.next_run_date + INTERVAL '1 day'
    WHEN 'weekly' THEN s.next_run_date + INTERVAL '7 days'
    WHEN 'monthly' THEN s.next_run_date + INTERVAL '1 month'
    WHEN 'semi_annual' THEN s.next_run_date + INTERVAL '6 months'
    WHEN 'yearly' THEN s.next_run_date + INTERVAL '1 year'
  END;

  UPDATE recurring_schedules SET
    next_run_date = v_next,
    last_run_at = now(),
    last_generated_type = s.schedule_type,
    last_generated_id = v_new_id
  WHERE id = p_schedule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
