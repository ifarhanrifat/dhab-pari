-- Migration 366: fee-charging training academies (cricket/football/etc.)
-- as real projects, plus the roster/fee layer on top of them.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why this isn't a repurposed training_programs/wazifa/kafalat row
-- ═════════════════════════════════════════════════════════════════════════
-- training_programs (332) stays exactly what it is — a free listing +
-- registration for one-off workshops, no money involved. An academy that
-- charges a monthly or per-course fee is instead a real `projects` row
-- (category='sports'/'training', funding_model='recurring_support' for a
-- trainer's ongoing salary) so it gets, for free, everything a project
-- already has: a public card with votes/comments/likes, its own ledger
-- account (trg_project_ensure_account, 358), display_name/privacy flags
-- (359-365), and — the whole reason recurring_support exists — staying
-- donatable and visible even once a season is marked "completed".
--
-- The fee/roster itself doesn't fit `donors` (that table backs "top
-- donors"/badge-tier logic — a mandatory training fee isn't a donation)
-- and doesn't fit recurring_schedules (schedule_type is a hard 3-way
-- bill/donation/expense CHECK with type-specific columns per branch).
-- Wazifa's wazifa_installment_charges (270) is the right shape instead:
-- "this specific person owes the committee a fixed amount on a schedule,
-- tracked due/part_paid/paid" — training_fee_charges below is that same
-- shape, one level removed (charges belong to an *enrollment*, not
-- directly to a student row, since the same project can hold many
-- enrollments and an enrollment can be a non-portal walk-in).

-- ── 1. Projects: a 'training' category alongside the existing 'sports',
--      and the rate card (villager/outsider × monthly/full-course).
--      Nullable throughout — a free academy just leaves these at 0/null,
--      exactly how consumers.monthly_rate is "just type the number" with
--      no separate tiering table.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_category_check;
ALTER TABLE projects ADD CONSTRAINT projects_category_check
  CHECK (category IN ('infrastructure', 'water', 'health', 'education', 'environment', 'welfare', 'sports', 'training', 'other'));

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS fee_villager_monthly_pkr decimal,
  ADD COLUMN IF NOT EXISTS fee_outsider_monthly_pkr decimal,
  ADD COLUMN IF NOT EXISTS fee_villager_full_pkr decimal,
  ADD COLUMN IF NOT EXISTS fee_outsider_full_pkr decimal;

-- ── 2. training_enrollments — one row per student/player registered into
--      a fee-charging academy (project). portal_user_id is nullable: a
--      walk-in registered by the trainer/staff has no portal account.
CREATE TABLE IF NOT EXISTS training_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  portal_user_id uuid REFERENCES portal_users(id),
  student_name varchar NOT NULL,
  student_name_ur varchar,
  guardian_name varchar,
  guardian_whatsapp_number varchar,
  address text,
  sector varchar,
  participant_type varchar NOT NULL CHECK (participant_type IN ('villager', 'outsider')),
  fee_type varchar NOT NULL CHECK (fee_type IN ('monthly', 'full_course')),
  -- Resolved from the project's rate card at registration time and stored
  -- here, not looked up live each time — a later rate change shouldn't
  -- retroactively change what an already-enrolled student owes.
  fee_amount_pkr decimal NOT NULL DEFAULT 0 CHECK (fee_amount_pkr >= 0),
  discount_pct decimal CHECK (discount_pct IS NULL OR (discount_pct >= 0 AND discount_pct <= 100)),
  discount_amount_pkr decimal CHECK (discount_amount_pkr IS NULL OR discount_amount_pkr >= 0),
  -- Free text, e.g. "sibling of DP-ENR-0014" — a human decision recorded
  -- for audit, not an automatic family-linkage system.
  discount_reason text,
  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'withdrawn')),
  enrolled_at timestamptz DEFAULT now(),
  registered_by uuid REFERENCES admin_users(id)
);

CREATE INDEX IF NOT EXISTS training_enrollments_project_idx ON training_enrollments(project_id, status);
CREATE INDEX IF NOT EXISTS training_enrollments_guardian_idx ON training_enrollments(guardian_whatsapp_number) WHERE guardian_whatsapp_number IS NOT NULL;

ALTER TABLE training_enrollments ENABLE ROW LEVEL SECURITY;

-- Staff write, same gate as `projects` itself (manage_parties) — trainer
-- scoping (assigned_training_program_ids) is a later phase, layered on
-- top of this same policy rather than replacing it.
CREATE POLICY training_enrollments_admin ON training_enrollments FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));

-- A portal user reads their own enrollment(s) — same "read-only, no
-- self-service edit/cancel" stance as wazifa_installment_charges_own.
CREATE POLICY training_enrollments_own ON training_enrollments FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());

-- ── 3. training_fee_charges — the actual due/paid ledger of instalments,
--      one row per charge (one for the whole course, or one per month).
CREATE TABLE IF NOT EXISTS training_fee_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES training_enrollments(id) ON DELETE CASCADE,
  charge_no int NOT NULL,
  due_on date NOT NULL,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  paid_pkr decimal NOT NULL DEFAULT 0,
  status varchar NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'part_paid', 'paid', 'waived')),
  voucher_id uuid REFERENCES vouchers(id),
  paid_on date,
  method varchar CHECK (method IN ('cash', 'bank', 'jazzcash', 'easypaisa')),
  note text,
  -- Set when a trainer/collector took the cash — the hook the next phase
  -- (field-collector-style scoping) hangs off, same column name/shape as
  -- wazifa_installment_charges.paid_by and payments.collected_by.
  collected_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (enrollment_id, charge_no)
);

CREATE INDEX IF NOT EXISTS training_fee_charges_enrollment_idx ON training_fee_charges(enrollment_id, status);
CREATE INDEX IF NOT EXISTS training_fee_charges_due_idx ON training_fee_charges(due_on) WHERE status IN ('due', 'part_paid');

ALTER TABLE training_fee_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY training_fee_charges_admin ON training_fee_charges FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

CREATE POLICY training_fee_charges_own ON training_fee_charges FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM training_enrollments e WHERE e.id = training_fee_charges.enrollment_id
                   AND e.portal_user_id = current_portal_user_id()));

-- ── 4. Enrolling a student — resolves the fee from the project's rate
--      card + participant_type + fee_type, applies any discount, and (for
--      fee_type='full_course') raises the single charge immediately since
--      there's no monthly cadence to wait for.
CREATE OR REPLACE FUNCTION enroll_in_training_program(
  p_project_id uuid, p_student_name varchar, p_student_name_ur varchar,
  p_guardian_name varchar, p_guardian_whatsapp_number varchar, p_address text, p_sector varchar,
  p_participant_type varchar, p_fee_type varchar,
  p_discount_pct decimal DEFAULT NULL, p_discount_amount_pkr decimal DEFAULT NULL, p_discount_reason text DEFAULT NULL,
  p_portal_user_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_proj projects%ROWTYPE;
  v_base decimal;
  v_fee decimal;
  v_enrollment_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_proj FROM projects WHERE id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project not found' USING ERRCODE = 'P0001'; END IF;

  v_base := CASE
    WHEN p_fee_type = 'monthly' AND p_participant_type = 'villager' THEN COALESCE(v_proj.fee_villager_monthly_pkr, 0)
    WHEN p_fee_type = 'monthly' AND p_participant_type = 'outsider' THEN COALESCE(v_proj.fee_outsider_monthly_pkr, 0)
    WHEN p_fee_type = 'full_course' AND p_participant_type = 'villager' THEN COALESCE(v_proj.fee_villager_full_pkr, 0)
    WHEN p_fee_type = 'full_course' AND p_participant_type = 'outsider' THEN COALESCE(v_proj.fee_outsider_full_pkr, 0)
    ELSE 0
  END;

  v_fee := v_base;
  IF p_discount_pct IS NOT NULL THEN v_fee := v_fee - (v_fee * p_discount_pct / 100); END IF;
  IF p_discount_amount_pkr IS NOT NULL THEN v_fee := v_fee - p_discount_amount_pkr; END IF;
  IF v_fee < 0 THEN v_fee := 0; END IF;

  INSERT INTO training_enrollments (
    project_id, portal_user_id, student_name, student_name_ur, guardian_name, guardian_whatsapp_number,
    address, sector, participant_type, fee_type, fee_amount_pkr,
    discount_pct, discount_amount_pkr, discount_reason, registered_by
  ) VALUES (
    p_project_id, p_portal_user_id, p_student_name, p_student_name_ur, p_guardian_name, p_guardian_whatsapp_number,
    p_address, p_sector, p_participant_type, p_fee_type, v_fee,
    p_discount_pct, p_discount_amount_pkr, p_discount_reason, current_admin_user_id()
  ) RETURNING id INTO v_enrollment_id;

  -- A full-course fee has no monthly cadence to wait for — raise its one
  -- charge now. A monthly fee's first charge is raised by
  -- training_fee_run() below, same as Wazifa's installment cron.
  IF p_fee_type = 'full_course' AND v_fee > 0 THEN
    INSERT INTO training_fee_charges (enrollment_id, charge_no, due_on, amount_pkr)
    VALUES (v_enrollment_id, 1, (now() AT TIME ZONE 'Asia/Karachi')::date, v_fee);
  END IF;

  RETURN v_enrollment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid) TO authenticated;

-- ── 5. Monthly charge generation — same idempotent-per-month shape as
--      wazifa_installment_run() (270): a daily cron no-ops after the
--      first successful run each month rather than depending on firing
--      on exactly the 1st.
CREATE OR REPLACE FUNCTION training_fee_run() RETURNS jsonb AS $$
DECLARE
  v_month date; v_due_on date; v_count int := 0; v_next_no int; r record;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT e.id AS enrollment_id, e.fee_amount_pkr AS amount, e.portal_user_id
      FROM training_enrollments e
     WHERE e.status = 'active' AND e.fee_type = 'monthly' AND e.fee_amount_pkr > 0
       AND NOT EXISTS (SELECT 1 FROM training_fee_charges c
                        WHERE c.enrollment_id = e.id
                          AND c.due_on >= v_month AND c.due_on < v_month + interval '1 month')
  LOOP
    v_due_on := v_month;
    SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no FROM training_fee_charges WHERE enrollment_id = r.enrollment_id;

    INSERT INTO training_fee_charges (enrollment_id, charge_no, due_on, amount_pkr)
    VALUES (r.enrollment_id, v_next_no, v_due_on, r.amount);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'training_fee_due', 'Training fee due',
        'Rs ' || trim(to_char(r.amount, 'FM999,999,999,990')) || ' is due this month',
        '/portal/training-programs');
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('charges_raised', v_count, 'month', v_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION training_fee_run() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION training_fee_run() TO authenticated;

DO $$
BEGIN
  PERFORM cron.schedule('training-fee-run', '25 4 * * *', 'SELECT training_fee_run()');
  RAISE NOTICE 'pg_cron: training fee charges raised daily at 09:25 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run training_fee_run() by hand. %', SQLERRM;
END $$;

-- ── 6. Recording a payment — mirrors wazifa_pay_installment_charge() but
--      posts directly to the project's own ledger account (via
--      ensure_project_account, 118) rather than a welfare measuring
--      account, since a training fee is real project income, not a
--      donation or a welfare disbursement. Kept self-contained (inserts
--      both ledger legs itself) rather than routing through the shared
--      voucher_type dispatcher, so this doesn't need to touch that
--      15-migration-deep function to add a new branch.
CREATE OR REPLACE FUNCTION pay_training_fee_charge(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE; proj projects%ROWTYPE;
  v_cash uuid; v_project_account uuid; v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this charge.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;
  SELECT * INTO proj FROM projects WHERE id = e.project_id;
  v_project_account := ensure_project_account(e.project_id);
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  -- post_voucher_ledger_legs_base()'s generic branch debits to_account_id
  -- and credits from_account_id — the project (receiving the fee) goes in
  -- from_account_id so it's credited, cash goes in to_account_id so it's
  -- debited (asset increase). Superseded by the collector-aware version in
  -- migration 367 anyway, kept correct here too for a reader working
  -- through the migrations in order.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, project_id)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    e.student_name || ' — training fee, charge ' || c.charge_no || ' (' || COALESCE(proj.display_name, proj.title) || ')'
      || COALESCE(' · ' || p_note, ''),
    p_amount, v_project_account, v_cash, e.student_name, e.project_id)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE training_fee_charges
     SET paid_pkr = paid_pkr + p_amount,
         status = CASE WHEN paid_pkr + p_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), collected_by = current_admin_user_id()
   WHERE id = p_charge_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pay_training_fee_charge(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pay_training_fee_charge(uuid, decimal, varchar, text) TO authenticated;

-- ── 7. The portal user's own read of their child's/own fee status —
--      same shape as my_wazifa_installments(), powers a "my fees" card.
CREATE OR REPLACE FUNCTION my_training_fees() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'enrollment_id', e.id, 'project_id', e.project_id,
    'program_title', COALESCE(proj.display_name, proj.title), 'student_name', e.student_name,
    'fee_type', e.fee_type, 'monthly_amount_pkr', e.fee_amount_pkr,
    'due_soon', (SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'due_on', c.due_on, 'amount', c.amount_pkr, 'paid', c.paid_pkr, 'status', c.status
      ) ORDER BY c.due_on) FROM training_fee_charges c
      WHERE c.enrollment_id = e.id AND c.status IN ('due', 'part_paid')),
    'total_paid', (SELECT COALESCE(SUM(paid_pkr), 0) FROM training_fee_charges WHERE enrollment_id = e.id),
    'total_overdue', (SELECT COALESCE(SUM(amount_pkr - paid_pkr), 0) FROM training_fee_charges
      WHERE enrollment_id = e.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date)
  ) ORDER BY e.enrolled_at DESC), '[]'::jsonb)
  FROM training_enrollments e
  JOIN projects proj ON proj.id = e.project_id
  WHERE e.portal_user_id = current_portal_user_id() AND e.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION my_training_fees() TO authenticated;

-- ── 8. Notification event types — same seeding pattern as every prior
--      new event type (056, 289, etc.): staff-side preferences seeded
--      here; the portal side (training_fee_due, inserted directly above)
--      has no preference table, matching how every other portal event
--      already works.
INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled)
VALUES
  ('training_fee_collected', 'Training fee collected by a trainer/collector', false, true),
  ('training_fee_overdue', 'Training fee overdue', false, true)
ON CONFLICT (event_type) DO NOTHING;
