-- Migration 270: the fixed monthly instalment itself — raised on the 1st,
-- at the figure the committee fixed, for as long as the award stays active.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why this is its own table, not a repurposed wazifa_instalments row
-- ═════════════════════════════════════════════════════════════════════════
-- wazifa_instalments (migration 212) is the committee paying an institute or
-- a student a lumpy, purpose-dated cost — admission fee, semester fee,
-- hostel deposit. That design is correct and untouched. wazifa_repayment_
-- schedule (migration 214/235) is a graduate paying a loan back, and only
-- starts once they are employed. Neither is "the student, while studying,
-- owes the committee a fixed amount every month, starting the day the
-- agreement is signed." A third table pretending to be either of the other
-- two would need a kind column and branching logic threading three
-- different real-world arrangements through one shape — worse than three
-- tables that each say one plain thing.
--
-- Payment is recorded as a 'wazifa_contribution' voucher — not a new
-- voucher_type — because that is exactly what this already is economically:
-- the student's own contribution toward their cost while studying,
-- migration 219/235 already built the full posting (cash + the measuring
-- account via wazifa_post_requirement_delta). This only adds where the
-- amount and the due date come from: a schedule, not a manual entry.

CREATE TABLE IF NOT EXISTS wazifa_installment_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES wazifa_awards(id) ON DELETE CASCADE,
  charge_no int NOT NULL,
  due_on date NOT NULL,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  paid_pkr decimal NOT NULL DEFAULT 0,
  status varchar NOT NULL DEFAULT 'due'
    CHECK (status IN ('due', 'part_paid', 'paid', 'waived')),
  voucher_id uuid REFERENCES vouchers(id),
  paid_on date,
  method varchar CHECK (method IN ('cash', 'bank', 'jazzcash', 'easypaisa')),
  note text,
  paid_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (award_id, charge_no)
);

CREATE INDEX IF NOT EXISTS wazifa_installment_charges_award_idx
  ON wazifa_installment_charges(award_id, status);
CREATE INDEX IF NOT EXISTS wazifa_installment_charges_due_idx
  ON wazifa_installment_charges(due_on) WHERE status IN ('due', 'part_paid');

ALTER TABLE wazifa_installment_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY wazifa_installment_charges_admin ON wazifa_installment_charges FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

-- Read-only for the student it belongs to — the whole point of the ask was
-- that they cannot touch this, only see it. There is no portal INSERT,
-- UPDATE, or DELETE policy at all, which is what actually enforces
-- "the student can't cancel this," not a disabled button in the UI.
CREATE POLICY wazifa_installment_charges_own ON wazifa_installment_charges FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_installment_charges.award_id
                    AND s.portal_user_id = current_portal_user_id()));

-- ── Raising the month's charge ────────────────────────────────────────────
-- Same shape as wazifa_repayment_run() (migration 235): idempotent per
-- month via NOT EXISTS, scheduled daily so it simply no-ops after the first
-- successful run each month rather than depending on the cron firing on
-- exactly the 1st.
CREATE OR REPLACE FUNCTION wazifa_installment_run() RETURNS jsonb AS $$
DECLARE
  v_month date; v_due_on date; v_count int := 0; v_next_no int; r record;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT a.id AS award_id, a.student_id, s.portal_user_id, s.full_name,
           a.student_monthly_contribution_pkr AS amount, a.installment_due_day AS due_day
      FROM wazifa_awards a
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE a.installment_active AND a.status = 'active'
       AND COALESCE(a.student_monthly_contribution_pkr, 0) > 0
       AND a.installment_due_day IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM wazifa_installment_charges ic
                        WHERE ic.award_id = a.id
                          AND ic.due_on >= v_month AND ic.due_on < v_month + interval '1 month')
  LOOP
    v_due_on := v_month + (r.due_day - 1);
    SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no
      FROM wazifa_installment_charges WHERE award_id = r.award_id;

    INSERT INTO wazifa_installment_charges (award_id, charge_no, due_on, amount_pkr)
    VALUES (r.award_id, v_next_no, v_due_on, r.amount);

    -- Same card/pooling alert the request asked for — one row in the same
    -- table every other portal notification already lands in.
    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'wazifa_installment_due', 'Taleemi Wazifa instalment due',
        'Rs ' || trim(to_char(r.amount, 'FM999,999,999,990')) || ' is due by ' || to_char(v_due_on, 'DD Mon'),
        '/portal/wazifa');
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('charges_raised', v_count, 'month', v_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_installment_run() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_installment_run() TO authenticated;

DO $$
BEGIN
  PERFORM cron.schedule('wazifa-installment-run', '20 4 * * *', 'SELECT wazifa_installment_run()');
  RAISE NOTICE 'pg_cron: taleemi wazifa instalments raised daily at 09:20 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run wazifa_installment_run() by hand. %', SQLERRM;
END $$;

-- ── Recording a payment against a raised charge ──────────────────────────
CREATE OR REPLACE FUNCTION wazifa_pay_installment_charge(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c wazifa_installment_charges%ROWTYPE; aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM wazifa_installment_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Instalment not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this instalment.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = c.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — instalment due ' || to_char(c.due_on, 'Mon YYYY')
      || COALESCE(' · ' || p_note, ''),
    p_amount, v_cash, v_cash, st.full_name, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE wazifa_installment_charges
     SET paid_pkr = paid_pkr + p_amount,
         status = CASE WHEN paid_pkr + p_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), paid_by = current_admin_user_id()
   WHERE id = p_charge_id;

  UPDATE wazifa_awards SET contributed_pkr = contributed_pkr + p_amount WHERE id = c.award_id;

  -- The measuring account only — not the student's own subsidiary account.
  -- The voucher just inserted already carries wazifa_student_id, so
  -- post_welfare_voucher_legs() (migration 224) has already posted that leg
  -- via its AFTER INSERT trigger. Passing p_student_id here too would post
  -- it a second time — the exact double-count this migration's own header
  -- comment on wazifa_record_contribution (fixed alongside this, migration
  -- 272) explains in full.
  PERFORM wazifa_post_requirement_delta(aw.academic_year, -p_amount,
    st.full_name || ' — instalment ' || to_char(c.due_on, 'Mon YYYY'));

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) TO authenticated;

-- ── The student's own read of it — powers the Recurring-page card ───────
CREATE OR REPLACE FUNCTION my_wazifa_installments() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'award_id', a.id, 'academic_year', a.academic_year,
    'monthly_amount_pkr', a.student_monthly_contribution_pkr, 'due_day', a.installment_due_day,
    'installment_active', a.installment_active,
    'due_soon', (SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'due_on', c.due_on, 'amount', c.amount_pkr, 'paid', c.paid_pkr, 'status', c.status
      ) ORDER BY c.due_on) FROM wazifa_installment_charges c
      WHERE c.award_id = a.id AND c.status IN ('due', 'part_paid')),
    'total_paid', (SELECT COALESCE(SUM(paid_pkr), 0) FROM wazifa_installment_charges WHERE award_id = a.id),
    'total_overdue', (SELECT COALESCE(SUM(amount_pkr - paid_pkr), 0) FROM wazifa_installment_charges
      WHERE award_id = a.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date)
  ) ORDER BY a.created_at DESC), '[]'::jsonb)
  FROM wazifa_awards a
  JOIN wazifa_students s ON s.id = a.student_id
  WHERE s.portal_user_id = current_portal_user_id() AND a.installment_active;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_installments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_installments() TO authenticated;
