-- Migration 015: Recurring bills, donations, and expenses.
--
-- A schedule auto-generates its transaction (and posts to the ledger exactly like a
-- manually-created one) on its frequency, advancing next_run_date each time. Sending
-- the receipt stays a deliberate one-tap action (WhatsApp Business API would be
-- required for zero-touch sending, which this project isn't using) — generated items
-- surface in a "Ready to Send" queue instead.

CREATE TABLE IF NOT EXISTS recurring_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL CHECK (system IN ('water_supply', 'donors_projects')),
  schedule_type varchar NOT NULL CHECK (schedule_type IN ('bill', 'donation', 'expense')),
  frequency varchar NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  next_run_date date NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_generated_type varchar,
  last_generated_id uuid,

  -- bill fields
  consumer_id varchar REFERENCES consumers(consumer_id) ON DELETE CASCADE,
  due_date_offset_days int,

  -- donation fields
  donor_name varchar,
  donor_name_ur varchar,
  donor_phone varchar,
  donor_type varchar,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,

  -- expense fields
  from_account_id uuid REFERENCES accounts(id),
  to_account_id uuid REFERENCES accounts(id),
  party_name varchar,

  -- shared
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  payment_method varchar,
  particular text,

  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recurring_schedules_due_idx ON recurring_schedules(next_run_date) WHERE is_active = true;

ALTER TABLE recurring_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "recurring_schedules_read" ON recurring_schedules FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "recurring_schedules_write" ON recurring_schedules FOR INSERT TO authenticated
  WITH CHECK (can_access_system(system) AND current_admin_permission('post_transactions'));
CREATE POLICY "recurring_schedules_update" ON recurring_schedules FOR UPDATE TO authenticated
  USING (can_access_system(system)) WITH CHECK (can_access_system(system) AND current_admin_permission('post_transactions'));
CREATE POLICY "recurring_schedules_delete" ON recurring_schedules FOR DELETE TO authenticated
  USING (can_access_system(system) AND current_admin_permission('post_transactions'));

-- Generates the one transaction for a single due schedule and advances it.
CREATE OR REPLACE FUNCTION run_recurring_schedule(p_schedule_id uuid) RETURNS void AS $$
DECLARE
  s recurring_schedules%ROWTYPE;
  v_new_id uuid;
  v_next date;
BEGIN
  SELECT * INTO s FROM recurring_schedules WHERE id = p_schedule_id AND is_active = true;
  IF NOT FOUND THEN RETURN; END IF;

  IF s.schedule_type = 'bill' THEN
    INSERT INTO bills (consumer_id, month, year, amount_pkr, due_date, description)
    VALUES (s.consumer_id, EXTRACT(MONTH FROM s.next_run_date)::int, EXTRACT(YEAR FROM s.next_run_date)::int,
            s.amount_pkr, s.next_run_date + COALESCE(s.due_date_offset_days, 7), s.particular)
    ON CONFLICT (consumer_id, month, year) DO NOTHING
    RETURNING id INTO v_new_id;

  ELSIF s.schedule_type = 'donation' THEN
    INSERT INTO donors (name, name_ur, phone, donor_type, amount_pkr, date, payment_method, project_id, is_verified, is_anonymous)
    VALUES (s.donor_name, s.donor_name_ur, s.donor_phone, s.donor_type, s.amount_pkr, s.next_run_date,
            s.payment_method, s.project_id, true, false)
    RETURNING id INTO v_new_id;

  ELSIF s.schedule_type = 'expense' THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES (s.system, 'expense', s.next_run_date, COALESCE(s.particular, 'Recurring expense'), s.amount_pkr,
            s.from_account_id, s.to_account_id, s.party_name)
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

-- Runs every schedule that's currently due. Safe to call repeatedly (a schedule that
-- isn't due yet is simply skipped) — this is what both pg_cron and the app's own
-- fallback check call.
CREATE OR REPLACE FUNCTION run_due_recurring_schedules() RETURNS void AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM recurring_schedules WHERE is_active = true AND next_run_date <= current_date LOOP
    PERFORM run_recurring_schedule(r.id);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Best-effort: schedule it to run daily via pg_cron if the extension is available on
-- this project. If it isn't (or can't be enabled from a migration), this is skipped
-- without failing the migration — the app also calls run_due_recurring_schedules()
-- as a fallback whenever the Recurring page loads, so the feature still works either way.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('run-recurring-schedules', '0 6 * * *', 'SELECT run_due_recurring_schedules()');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — relying on the app-level fallback check instead: %', SQLERRM;
END $$;
