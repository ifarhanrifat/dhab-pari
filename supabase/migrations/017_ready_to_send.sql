-- Migration 017: Make the "Ready to Send" queue robust instead of relying on a
-- single-slot last_generated_id pointer on the schedule row.
--
-- Live testing surfaced a real weak spot: last_generated_id is a single mutable slot,
-- so if a schedule catches up more than one overdue period in a row (or two calls
-- race), only the most recent write survives — even though every period's bill/
-- donation is genuinely created and correctly posted to the ledger every time. This
-- replaces that pointer-based tracking with a proper per-record marker so every
-- unsent generated item shows up, not just the last one.

ALTER TABLE bills ADD COLUMN IF NOT EXISTS recurring_schedule_id uuid REFERENCES recurring_schedules(id) ON DELETE SET NULL;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS whatsapp_sent_at timestamptz;
ALTER TABLE donors ADD COLUMN IF NOT EXISTS recurring_schedule_id uuid REFERENCES recurring_schedules(id) ON DELETE SET NULL;
ALTER TABLE donors ADD COLUMN IF NOT EXISTS whatsapp_sent_at timestamptz;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS recurring_schedule_id uuid REFERENCES recurring_schedules(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION run_recurring_schedule(p_schedule_id uuid) RETURNS void AS $$
DECLARE
  s recurring_schedules%ROWTYPE;
  v_new_id uuid;
  v_next date;
BEGIN
  SELECT * INTO s FROM recurring_schedules
  WHERE id = p_schedule_id AND is_active = true AND next_run_date <= current_date
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF s.schedule_type = 'bill' THEN
    INSERT INTO bills (consumer_id, month, year, amount_pkr, due_date, description, recurring_schedule_id)
    VALUES (s.consumer_id, EXTRACT(MONTH FROM s.next_run_date)::int, EXTRACT(YEAR FROM s.next_run_date)::int,
            s.amount_pkr, s.next_run_date + COALESCE(s.due_date_offset_days, 7), s.particular, s.id)
    ON CONFLICT (consumer_id, month, year) DO NOTHING
    RETURNING id INTO v_new_id;

  ELSIF s.schedule_type = 'donation' THEN
    INSERT INTO donors (name, name_ur, phone, donor_type, amount_pkr, date, payment_method, project_id, is_verified, is_anonymous, recurring_schedule_id)
    VALUES (s.donor_name, s.donor_name_ur, s.donor_phone, s.donor_type, s.amount_pkr, s.next_run_date,
            s.payment_method, s.project_id, true, false, s.id)
    RETURNING id INTO v_new_id;

  ELSIF s.schedule_type = 'expense' THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, recurring_schedule_id)
    VALUES (s.system, 'expense', s.next_run_date, COALESCE(s.particular, 'Recurring expense'), s.amount_pkr,
            s.from_account_id, s.to_account_id, s.party_name, s.id)
    RETURNING id INTO v_new_id;
  END IF;

  v_next := CASE s.frequency
    WHEN 'daily' THEN s.next_run_date + INTERVAL '1 day'
    WHEN 'weekly' THEN s.next_run_date + INTERVAL '7 days'
    WHEN 'monthly' THEN s.next_run_date + INTERVAL '1 month'
  END;

  UPDATE recurring_schedules SET
    next_run_date = v_next,
    last_run_at = now(),
    last_generated_type = s.schedule_type,
    last_generated_id = v_new_id
  WHERE id = p_schedule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
