-- Migration 263: the Kafalat monthly payment form.
--
-- Most of the plumbing for paying a child's expenses already existed
-- (kafalat_pay_fee_item / kafalat_pay_disbursement / kafalat_issue_uniform,
-- migration 241) — but each one posts its own separate voucher, none of
-- them go through the multi-approver gate every other real payout does,
-- there's no way to pay several months at once, and "stationery" and a
-- genuinely unplanned "other" expense have nowhere to go. This closes those
-- four gaps without discarding what already works: the existing queues,
-- the fee/disbursement/uniform tracking tables, and kafalat_child_expense_
-- record() all keep functioning exactly as they do today for the per-item
-- flows already wired into the Operations tab.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Part A — Kafalat payouts never actually required approval
-- ═════════════════════════════════════════════════════════════════════════
-- voucher_requires_approval() (migration 218) gates 'withdrawal', 'expense',
-- 'advance', 'advance_settlement', 'complaint_waiver', 'project_transfer' —
-- 'kafalat_payment' was never added, so every Kafalat payout since
-- migration 218 shipped has posted immediately with no confirmation step,
-- unlike water_supply's expense vouchers.
CREATE OR REPLACE FUNCTION voucher_requires_approval(p_system varchar, p_voucher_type varchar) RETURNS boolean AS $$
DECLARE v_requires boolean; v_has_approvers boolean;
BEGIN
  v_requires := p_voucher_type IN ('withdrawal', 'expense', 'advance', 'advance_settlement',
                                   'complaint_waiver', 'project_transfer', 'kafalat_payment')
    AND approval_type_enabled(p_system, CASE WHEN p_voucher_type = 'withdrawal' THEN 'withdrawal' ELSE 'expense' END);
  IF v_requires THEN
    SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = p_system AND is_active = true) INTO v_has_approvers;
    v_requires := v_has_approvers;
  END IF;
  RETURN COALESCE(v_requires, false);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- Part B — stationery, and paying several months at once
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE kafalat_package_lines DROP CONSTRAINT IF EXISTS kafalat_package_lines_category_check;
ALTER TABLE kafalat_package_lines ADD CONSTRAINT kafalat_package_lines_category_check
  CHECK (category IN ('school_fee', 'uniform', 'books', 'stationery', 'transport',
                      'pocket_money', 'medical', 'exam_fee', 'tuition', 'other'));

-- Books and stationery are budgeted together today (migration 217's default
-- package never split them) — a child with an existing 'books' line isn't
-- missing anything, 'stationery' is just now available as its own line for
-- whoever wants to track the recurring bit separately.
ALTER TABLE kafalat_fee_payments
  ADD COLUMN IF NOT EXISTS months_covered int NOT NULL DEFAULT 1 CHECK (months_covered >= 1),
  ADD COLUMN IF NOT EXISTS covers_until date;

-- An ad-hoc expense (Part D) has no budget line to point at.
ALTER TABLE kafalat_fee_payments ALTER COLUMN package_line_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION kafalat_pay_fee_item(
  p_line_id uuid, p_amount decimal, p_method varchar, p_paid_to varchar DEFAULT NULL,
  p_signed_by varchar DEFAULT NULL, p_proof_url text DEFAULT NULL, p_note text DEFAULT NULL,
  p_months_covered int DEFAULT 1
) RETURNS jsonb AS $$
DECLARE
  l kafalat_package_lines%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_payment_id uuid; v_covers_until date;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be more than zero.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM kafalat_package_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = l.child_id;

  v_covers_until := (CASE WHEN p_months_covered > 1
    THEN ((now() AT TIME ZONE 'Asia/Karachi')::date + (make_interval(months => p_months_covered - 1)))
    ELSE NULL END);

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — ' || l.category || ', ' || l.academic_year
      || COALESCE(' — ' || p_paid_to, '')
      || CASE WHEN p_months_covered > 1 THEN ' — ' || p_months_covered || ' months in advance' ELSE '' END,
    p_amount, v_cash, v_cash, COALESCE(p_paid_to, c.first_name), l.child_id, 'kafalat')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
    paid_to, signed_by, proof_url, note, voucher_id, created_by, months_covered, covers_until)
  VALUES (p_line_id, l.child_id, l.category, p_amount, p_method, p_paid_to, p_signed_by,
    p_proof_url, p_note, v_voucher_id, current_admin_user_id(), GREATEST(p_months_covered, 1), v_covers_until)
  RETURNING id INTO v_payment_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'payment_id', v_payment_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Same idea for transport/pocket money — paying ahead marks this month's
-- scheduled row paid and generates+pays the following months too, so the
-- daily cron (kafalat_disbursement_run) finds them already settled and
-- skips right past them instead of asking again.
CREATE OR REPLACE FUNCTION kafalat_pay_disbursement(
  p_disbursement_id uuid, p_method varchar, p_signed_by varchar DEFAULT NULL,
  p_driver_name varchar DEFAULT NULL, p_signed_note text DEFAULT NULL, p_proof_url text DEFAULT NULL,
  p_months_covered int DEFAULT 1
) RETURNS jsonb AS $$
DECLARE
  d kafalat_disbursements%ROWTYPE; c kafalat_children%ROWTYPE; l kafalat_package_lines%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_total decimal; v_month date; i int;
  v_future_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO d FROM kafalat_disbursements WHERE id = p_disbursement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF d.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This is already %.', d.status USING ERRCODE = 'P0001';
  END IF;
  IF d.category = 'transport' AND COALESCE(trim(p_driver_name), '') = '' THEN
    RAISE EXCEPTION 'Name the driver — this is a transport payment.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = d.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  v_total := d.amount_pkr;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — ' || d.category || ', ' || to_char(d.month, 'Mon YYYY')
      || CASE WHEN p_months_covered > 1 THEN ' — ' || p_months_covered || ' months in advance' ELSE '' END,
    d.amount_pkr, v_cash, v_cash, COALESCE(p_driver_name, c.first_name), d.child_id, 'kafalat')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE kafalat_disbursements
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         recipient = CASE WHEN p_driver_name IS NOT NULL THEN 'driver' ELSE recipient END,
         driver_name = p_driver_name, signed_by = p_signed_by, signed_note = p_signed_note,
         proof_url = p_proof_url, voucher_id = v_voucher_id
   WHERE id = p_disbursement_id;

  -- The extra months: generate the row if the cron hasn't reached it yet
  -- (it only ever creates the current month's), then settle it against the
  -- very same voucher.
  IF p_months_covered > 1 THEN
    SELECT annual_amount_pkr / 12.0 INTO l FROM kafalat_package_lines
     WHERE child_id = d.child_id AND category = d.category
       AND academic_year = kafalat_current_year() LIMIT 1;

    FOR i IN 1..(p_months_covered - 1) LOOP
      v_month := (d.month + make_interval(months => i))::date;
      SELECT id INTO v_future_id FROM kafalat_disbursements
       WHERE child_id = d.child_id AND category = d.category AND month = v_month;
      IF v_future_id IS NULL THEN
        INSERT INTO kafalat_disbursements (child_id, category, month, amount_pkr, recipient, status)
        VALUES (d.child_id, d.category, v_month, d.amount_pkr,
                CASE WHEN d.category = 'transport' THEN 'driver' ELSE 'guardian' END, 'scheduled')
        RETURNING id INTO v_future_id;
      END IF;
      UPDATE kafalat_disbursements
         SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
             recipient = CASE WHEN p_driver_name IS NOT NULL THEN 'driver' ELSE recipient END,
             driver_name = p_driver_name, signed_by = p_signed_by,
             signed_note = COALESCE(signed_note, p_signed_note), proof_url = p_proof_url, voucher_id = v_voucher_id
       WHERE id = v_future_id AND status = 'scheduled';
      v_total := v_total + d.amount_pkr;
    END LOOP;
    UPDATE vouchers SET amount_pkr = v_total WHERE id = v_voucher_id;
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_pay_fee_item(uuid, decimal, varchar, varchar, varchar, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_pay_fee_item(uuid, decimal, varchar, varchar, varchar, text, text, int) TO authenticated;
REVOKE ALL ON FUNCTION kafalat_pay_disbursement(uuid, varchar, varchar, varchar, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_pay_disbursement(uuid, varchar, varchar, varchar, text, text, int) TO authenticated;

-- kafalat_fee_queue() now also reports how far ahead a line is already paid,
-- so the form can show "covered until Feb 2027" instead of asking again.
CREATE OR REPLACE FUNCTION kafalat_fee_queue() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'line_id', l.id, 'child_id', l.child_id, 'child_code', c.code, 'child_name', c.first_name,
    'guardian', c.guardian_name, 'guardian_phone', c.guardian_phone,
    'category', l.category, 'description', l.description, 'academic_year', l.academic_year,
    'budgeted', l.annual_amount_pkr,
    'paid_so_far', COALESCE((SELECT SUM(amount_pkr) FROM kafalat_fee_payments WHERE package_line_id = l.id), 0),
    'covered_until', (SELECT MAX(covers_until) FROM kafalat_fee_payments WHERE package_line_id = l.id)
  ) ORDER BY c.code, l.category), '[]'::jsonb)
  FROM kafalat_package_lines l JOIN kafalat_children c ON c.id = l.child_id
  WHERE l.category IN ('school_fee', 'books', 'stationery', 'medical', 'exam_fee', 'tuition', 'other')
    AND c.status = 'active' AND l.academic_year = kafalat_current_year();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- Part C — one form, one combined voucher, real ledger impact
-- ═════════════════════════════════════════════════════════════════════════
-- What the individual pay-actions above still do one at a time, this does
-- together: pick several due items for one child, one method, one proof per
-- item, and save once. Debits DP-5020 (Education Expenditure — Wazifa &
-- Kafalat, already the committee's own account for this) with one line per
-- item so the real breakdown survives; credits cash/bank for the total.
-- Goes through the same draft -> finalize_voucher() -> approval path as
-- every other multi-category expense in this system (migration 083), so it
-- is gated by the same multi-approver confirmation as a water_supply payout,
-- with one difference: a whole month's spending for one child is one
-- request to confirm, not five.
CREATE OR REPLACE FUNCTION kafalat_record_monthly_payment(
  p_child_id uuid, p_method varchar, p_items jsonb
) RETURNS jsonb AS $$
DECLARE
  c kafalat_children%ROWTYPE; v_cash uuid; v_expense_account uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_year varchar := kafalat_current_year();
  item jsonb; v_kind varchar; v_amount decimal; v_months int; v_desc text; v_category varchar;
  v_line kafalat_package_lines%ROWTYPE; v_disb kafalat_disbursements%ROWTYPE; v_unif kafalat_uniform_issues%ROWTYPE;
  v_covers_until date; v_month date; i int; v_future_id uuid;
  v_count int := 0;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Child not found' USING ERRCODE = 'P0001'; END IF;
  IF jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Add at least one item.' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  SELECT id INTO v_expense_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-5020';

  -- post_welfare_voucher_legs() (migration 224) is what actually posts a
  -- 'kafalat_payment' voucher — it reads to_account_id as the cash leg and
  -- p_voucher.amount_pkr as one lump sum (crediting cash, debiting DP-5020,
  -- and drawing down the Kafalat fund balance via fund_type); it never looks
  -- at voucher_line_items. Those rows still go in below — real per-item
  -- detail for the approver and the child's history — but the ledger itself
  -- is one clean debit/credit pair per voucher, same as every other
  -- kafalat_payment already posts.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type, status)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — monthly payment', 0, v_cash, v_cash, c.first_name, p_child_id, 'kafalat', 'draft')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_kind := item->>'kind';
    v_amount := (item->>'amount')::decimal;
    v_months := GREATEST(COALESCE((item->>'months_covered')::int, 1), 1);
    v_category := item->>'category';
    IF v_amount <= 0 THEN CONTINUE; END IF;
    v_covers_until := NULL;

    IF v_kind = 'fee' THEN
      SELECT * INTO v_line FROM kafalat_package_lines WHERE id = (item->>'line_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'A budget line in this form no longer exists.' USING ERRCODE = 'P0001'; END IF;
      v_desc := initcap(replace(v_line.category, '_', ' ')) || ', ' || v_line.academic_year
        || CASE WHEN v_months > 1 THEN ' — ' || v_months || ' months in advance' ELSE '' END;
      IF v_months > 1 THEN v_covers_until := (now() AT TIME ZONE 'Asia/Karachi')::date + make_interval(months => v_months - 1); END IF;

      INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
        proof_url, note, voucher_id, created_by, months_covered, covers_until)
      VALUES (v_line.id, p_child_id, v_line.category, v_amount, p_method,
        item->>'attachment_url', item->>'note', v_voucher_id, current_admin_user_id(), v_months, v_covers_until);

    ELSIF v_kind = 'disbursement' THEN
      SELECT * INTO v_disb FROM kafalat_disbursements WHERE id = (item->>'ref_id')::uuid FOR UPDATE;
      IF NOT FOUND OR v_disb.status <> 'scheduled' THEN
        RAISE EXCEPTION 'This month''s % is no longer awaiting payment.', v_category USING ERRCODE = 'P0001';
      END IF;
      v_desc := initcap(replace(v_disb.category, '_', ' ')) || ', ' || to_char(v_disb.month, 'Mon YYYY')
        || CASE WHEN v_months > 1 THEN ' — ' || v_months || ' months in advance' ELSE '' END;

      UPDATE kafalat_disbursements SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
        method = p_method, proof_url = item->>'attachment_url', voucher_id = v_voucher_id,
        driver_name = COALESCE(item->>'paid_to', driver_name), signed_note = item->>'note'
       WHERE id = v_disb.id;

      IF v_months > 1 THEN
        FOR i IN 1..(v_months - 1) LOOP
          v_month := (v_disb.month + make_interval(months => i))::date;
          SELECT id INTO v_future_id FROM kafalat_disbursements
           WHERE child_id = p_child_id AND category = v_disb.category AND month = v_month;
          IF v_future_id IS NULL THEN
            INSERT INTO kafalat_disbursements (child_id, category, month, amount_pkr, recipient, status)
            VALUES (p_child_id, v_disb.category, v_month, v_disb.amount_pkr,
                    CASE WHEN v_disb.category = 'transport' THEN 'driver' ELSE 'guardian' END, 'scheduled')
            RETURNING id INTO v_future_id;
          END IF;
          UPDATE kafalat_disbursements SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
            method = p_method, proof_url = item->>'attachment_url', voucher_id = v_voucher_id
           WHERE id = v_future_id AND status = 'scheduled';
        END LOOP;
      END IF;

    ELSIF v_kind = 'uniform' THEN
      SELECT * INTO v_unif FROM kafalat_uniform_issues WHERE id = (item->>'ref_id')::uuid FOR UPDATE;
      IF NOT FOUND OR v_unif.status <> 'scheduled' THEN
        RAISE EXCEPTION 'This uniform is no longer awaiting payment.' USING ERRCODE = 'P0001';
      END IF;
      v_desc := 'Uniform ' || v_unif.issue_no || '/2, ' || v_unif.academic_year;
      UPDATE kafalat_uniform_issues SET status = 'issued', issued_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
        received_by = COALESCE(item->>'paid_to', c.first_name), signed_note = item->>'note',
        proof_url = item->>'attachment_url', voucher_id = v_voucher_id
       WHERE id = v_unif.id;

    ELSIF v_kind = 'other' THEN
      v_desc := COALESCE(item->>'description', 'Other expense');
      INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
        paid_to, proof_url, note, voucher_id, created_by, months_covered)
      VALUES (NULL, p_child_id, 'other', v_amount, p_method, item->>'paid_to',
        item->>'attachment_url', v_desc, v_voucher_id, current_admin_user_id(), 1);
    ELSE
      RAISE EXCEPTION 'Unknown item kind: %', v_kind USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category, attachment_url, period_start, period_end)
    VALUES (v_voucher_id, v_expense_account, v_amount, v_desc, v_category, item->>'attachment_url',
      (now() AT TIME ZONE 'Asia/Karachi')::date, v_covers_until);
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    DELETE FROM vouchers WHERE id = v_voucher_id;
    RAISE EXCEPTION 'Nothing to save — every amount was zero.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM finalize_voucher(v_voucher_id);
  RETURN (SELECT jsonb_build_object('voucher_id', id, 'voucher_no', voucher_no, 'status', status, 'amount', amount_pkr)
          FROM vouchers WHERE id = v_voucher_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_record_monthly_payment(uuid, varchar, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_record_monthly_payment(uuid, varchar, jsonb) TO authenticated;

-- Per-line attachment and category, so a multi-category voucher's approver
-- (and this new form) can see/tag each item, not just the voucher as a
-- whole.
ALTER TABLE voucher_line_items
  ADD COLUMN IF NOT EXISTS category varchar,
  ADD COLUMN IF NOT EXISTS attachment_url text,
  ADD COLUMN IF NOT EXISTS period_start date,
  ADD COLUMN IF NOT EXISTS period_end date;

-- ═════════════════════════════════════════════════════════════════════════
-- Part D — the child's card: everything due right now, in one call
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION kafalat_child_payment_form_data(p_child_id uuid) RETURNS jsonb AS $$
DECLARE v_year varchar := kafalat_current_year();
BEGIN
  RETURN jsonb_build_object(
    'fee_items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'line_id', l.id, 'category', l.category, 'description', l.description,
        'budgeted', l.annual_amount_pkr,
        'paid_so_far', COALESCE((SELECT SUM(amount_pkr) FROM kafalat_fee_payments WHERE package_line_id = l.id), 0),
        'covered_until', (SELECT MAX(covers_until) FROM kafalat_fee_payments WHERE package_line_id = l.id)
      ) ORDER BY l.category)
      FROM kafalat_package_lines l
      WHERE l.child_id = p_child_id AND l.academic_year = v_year
        AND l.category IN ('school_fee', 'books', 'stationery', 'medical', 'exam_fee', 'tuition', 'other')
    ), '[]'::jsonb),
    'disbursements_due', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'category', d.category, 'month', d.month, 'amount', d.amount_pkr
      ) ORDER BY d.category)
      FROM kafalat_disbursements d
      WHERE d.child_id = p_child_id AND d.status = 'scheduled'
    ), '[]'::jsonb),
    'uniform_due', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', u.id, 'issue_no', u.issue_no, 'academic_year', u.academic_year, 'amount', u.amount_pkr
      ) ORDER BY u.issue_no)
      FROM kafalat_uniform_issues u
      WHERE u.child_id = p_child_id AND u.status = 'scheduled'
    ), '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_child_payment_form_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_child_payment_form_data(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION kafalat_fee_queue() TO authenticated;
