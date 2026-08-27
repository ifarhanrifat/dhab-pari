-- Migration 367: a trainer who collects a fee by hand — the exact same
-- "cash isn't in the box yet" pattern water/donor field collectors already
-- have (056, generalized to donors_projects by 119), extended with a new
-- scoping dimension (assigned_training_program_ids alongside the existing
-- assigned_sectors) and wired into pay_training_fee_charge() (366).

-- 1. Scoping column + self-guard extension (same shape as 056 §1a — a
--    viewer must not be able to grant themselves collection rights via a
--    crafted update).
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS assigned_training_program_ids uuid[];

CREATE OR REPLACE FUNCTION trg_admin_users_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'super_admin' AND OLD.role IS DISTINCT FROM 'super_admin' AND current_admin_role() != 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can grant the super_admin role.';
  END IF;

  IF NEW.auth_user_id = auth.uid() AND (
    NEW.role IS DISTINCT FROM OLD.role
    OR NEW.can_post_transactions IS DISTINCT FROM OLD.can_post_transactions
    OR NEW.can_edit_transactions IS DISTINCT FROM OLD.can_edit_transactions
    OR NEW.can_delete_transactions IS DISTINCT FROM OLD.can_delete_transactions
    OR NEW.can_view_reports IS DISTINCT FROM OLD.can_view_reports
    OR NEW.can_approve_transactions IS DISTINCT FROM OLD.can_approve_transactions
    OR NEW.can_manage_parties IS DISTINCT FROM OLD.can_manage_parties
    OR NEW.can_manage_accounts IS DISTINCT FROM OLD.can_manage_accounts
    OR NEW.can_edit_accounts IS DISTINCT FROM OLD.can_edit_accounts
    OR NEW.can_delete_accounts IS DISTINCT FROM OLD.can_delete_accounts
    OR NEW.can_restore_deleted IS DISTINCT FROM OLD.can_restore_deleted
    OR NEW.can_invite_users IS DISTINCT FROM OLD.can_invite_users
    OR NEW.access_water_supply IS DISTINCT FROM OLD.access_water_supply
    OR NEW.access_donors_projects IS DISTINCT FROM OLD.access_donors_projects
    OR NEW.can_collect_payments IS DISTINCT FROM OLD.can_collect_payments
    OR NEW.assigned_sectors IS DISTINCT FROM OLD.assigned_sectors
    OR NEW.assigned_training_program_ids IS DISTINCT FROM OLD.assigned_training_program_ids
  ) THEN
    RAISE EXCEPTION 'You cannot change your own role or permissions.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. RLS helpers — read-scoping for a trainer (their roster/charges only)
--    mirroring current_admin_can_collect_for_consumer() (056).
CREATE OR REPLACE FUNCTION current_admin_can_collect_for_training_program(p_project_id uuid) RETURNS boolean AS $$
  SELECT au.can_collect_payments AND p_project_id = ANY(au.assigned_training_program_ids)
  FROM admin_users au
  WHERE au.auth_user_id = auth.uid() AND au.is_active = true
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- A trainer reads only the roster/charges for their own assigned academy —
-- narrower than the existing training_enrollments_admin/training_fee_charges_admin
-- policies (which require manage_parties/full donors_projects access), so a
-- viewer-tier trainer with neither of those still sees their own students.
CREATE POLICY training_enrollments_trainer ON training_enrollments FOR SELECT TO authenticated
  USING (current_admin_can_collect_for_training_program(project_id));

CREATE POLICY training_fee_charges_trainer ON training_fee_charges FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM training_enrollments e
                  WHERE e.id = training_fee_charges.enrollment_id
                    AND current_admin_can_collect_for_training_program(e.project_id)));

-- 3. pay_training_fee_charge() — now collector-aware. A full accountant
--    (post_transactions) posts straight to real Cash/Bank exactly as
--    before. A scoped trainer with no post_transactions permission may
--    still call this for a charge on their assigned academy, but the cash
--    leg routes to their personal Collector Clearing sub-account
--    (ensure_collector_account(..., 'donors_projects'), already generic
--    since migration 119) instead — settled to real cash/bank later by an
--    accountant via the existing collector_settlements flow, same as
--    every other field collector.
CREATE OR REPLACE FUNCTION pay_training_fee_charge(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE; proj projects%ROWTYPE;
  v_is_full_accountant boolean;
  v_is_collector boolean;
  v_from_account uuid;
  v_project_account uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal;
  v_collected_by uuid;
  v_popup_enabled boolean;
  v_collector_name varchar;
  r record;
BEGIN
  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;

  v_is_full_accountant := COALESCE(current_admin_permission('post_transactions'), false);
  v_is_collector := current_admin_can_collect_for_training_program(e.project_id);
  IF NOT v_is_full_accountant AND NOT v_is_collector THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this charge.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO proj FROM projects WHERE id = e.project_id;
  v_project_account := ensure_project_account(e.project_id);

  -- A full accountant posting centrally leaves collected_by NULL and hits
  -- real cash/bank directly, same as always. A scoped trainer's collection
  -- is tagged to them and parked in their own clearing account instead —
  -- the money genuinely isn't in the committee's box yet.
  IF v_is_full_accountant AND NOT v_is_collector THEN
    v_collected_by := NULL;
    SELECT id INTO v_from_account FROM accounts WHERE system = 'donors_projects'
       AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  ELSE
    v_collected_by := current_admin_user_id();
    v_from_account := ensure_collector_account(v_collected_by, 'donors_projects');
  END IF;

  -- post_voucher_ledger_legs_base()'s generic (no special-cased voucher_type)
  -- branch debits to_account_id and credits from_account_id (confirmed
  -- against the project_transfer branch's own convention: money arriving
  -- into a project is a CREDIT there, same as the expense branch's project
  -- debit for money leaving) — so the project (receiving the fee) goes in
  -- from_account_id, and the cash/collector account (receiving the money
  -- itself, a debit-normal asset increase) goes in to_account_id.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, project_id)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    e.student_name || ' — training fee, charge ' || c.charge_no || ' (' || COALESCE(proj.display_name, proj.title) || ')'
      || COALESCE(' · ' || p_note, ''),
    p_amount, v_project_account, v_from_account, e.student_name, e.project_id)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE training_fee_charges
     SET paid_pkr = paid_pkr + p_amount,
         status = CASE WHEN paid_pkr + p_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), collected_by = v_collected_by
   WHERE id = p_charge_id;

  -- Same notification shape as trg_payment_collector_notify (056) — only
  -- when an actual collector (not a full accountant) took the cash.
  IF v_collected_by IS NOT NULL THEN
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'training_fee_collected';
    IF v_popup_enabled IS TRUE THEN
      SELECT full_name INTO v_collector_name FROM admin_users WHERE id = v_collected_by;
      FOR r IN
        SELECT id FROM admin_users
        WHERE is_active = true AND id != v_collected_by AND (
          role IN ('super_admin', 'admin', 'donor_accountant')
          OR (role = 'accountant' AND access_donors_projects)
        )
      LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (r.id, 'training_fee_collected', 'Training fee collected',
          COALESCE(v_collector_name, 'A trainer') || ' collected Rs ' || trim(to_char(p_amount, 'FM999,999,999,990'))
            || ' from ' || e.student_name || ' (' || COALESCE(proj.display_name, proj.title) || ')',
          '/admin/donors/collectors');
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id, 'collected_by', v_collected_by);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pay_training_fee_charge(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pay_training_fee_charge(uuid, decimal, varchar, text) TO authenticated;

-- 4. A trainer's own roster read — one call powering their scoped screen,
--    same idea as get_field_collectors_by_system() (119) but the other
--    direction (a collector reading their own assignment, not an
--    accountant listing all collectors).
CREATE OR REPLACE FUNCTION my_training_academy_roster() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'project_id', proj.id, 'program_title', COALESCE(proj.display_name, proj.title),
    'students', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'enrollment_id', en.id, 'student_name', en.student_name, 'participant_type', en.participant_type,
        'fee_type', en.fee_type, 'fee_amount_pkr', en.fee_amount_pkr, 'status', en.status,
        'charges', (SELECT jsonb_agg(jsonb_build_object(
            'id', c.id, 'charge_no', c.charge_no, 'due_on', c.due_on,
            'amount_pkr', c.amount_pkr, 'paid_pkr', c.paid_pkr, 'status', c.status
          ) ORDER BY c.charge_no) FROM training_fee_charges c WHERE c.enrollment_id = en.id)
      ) ORDER BY en.student_name), '[]'::jsonb)
      FROM training_enrollments en WHERE en.project_id = proj.id AND en.status = 'active'
    )
  )), '[]'::jsonb)
  FROM projects proj
  JOIN admin_users au ON au.auth_user_id = auth.uid()
  WHERE au.is_active = true AND au.can_collect_payments
    AND proj.id = ANY(au.assigned_training_program_ids);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION my_training_academy_roster() TO authenticated;
