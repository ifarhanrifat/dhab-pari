-- Migration 125: run_recurring_schedule() (migration 097) hardcodes
-- is_verified = true for every generated donation — correct for staff-
-- created schedules (a trusted standing arrangement an accountant already
-- set up), but migration 122 just let portal users create their OWN
-- recurring schedules unsupervised. Left as-is, the cron would silently
-- post a "verified" ledger entry every cycle for a self-service schedule
-- with no accountant review and no payment proof, corrupting real
-- financial records. A portal-created schedule's generated donation now
-- lands unverified/"announced" instead, going through the same
-- confirm_donation() review as any other donation; staff-created schedules
-- are completely unchanged.

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
