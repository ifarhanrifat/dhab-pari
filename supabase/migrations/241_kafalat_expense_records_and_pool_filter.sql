-- Migration 241: the paper trail the committee actually needs, and the
-- plumbing to fold Kafalat's pool-collection screen into /admin/kafalat.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Part A — a robust way to filter the shared pool functions to one pool
-- ═════════════════════════════════════════════════════════════════════════
-- pool_shortfall_queue()/pool_announcement_queue() (migrations 222/231) only
-- ever had one caller (the generic /admin/pools screen), so they returned
-- every pool mixed together with nothing sturdier than a display name to
-- filter on. Folding Kafalat's queue into its own page needs to filter to
-- just POOL-KFL without relying on string-matching a name that could change.
CREATE OR REPLACE FUNCTION pool_shortfall_queue() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'unrestricted_available', unrestricted_balance(),
    'months', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'pool_month_id', m.id, 'pool_id', p.id, 'pool_code', p.code, 'pool', p.name, 'pool_ur', p.name_ur,
        'month', m.month, 'required', m.required_pkr, 'received', m.received_pkr,
        'shortfall', m.shortfall_pkr, 'covered', m.committee_covered_pkr,
        'remaining', m.shortfall_pkr - m.committee_covered_pkr,
        'donors_active', m.donors_active, 'donors_needed', m.donors_needed,
        'status', m.status
      ) ORDER BY m.month DESC)
        FROM pool_months m JOIN support_pools p ON p.id = m.pool_id
       WHERE m.status = 'short' AND m.shortfall_pkr > m.committee_covered_pkr
    ), '[]'::jsonb),
    'lapsed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'commitment_id', c.id, 'pool_id', p.id, 'pool_code', p.code, 'pool', p.name, 'name', c.donor_name,
        'phone', c.donor_phone, 'amount', c.monthly_amount_pkr, 'since', c.lapsed_at
      ) ORDER BY c.lapsed_at DESC)
        FROM pool_commitments c JOIN support_pools p ON p.id = c.pool_id
       WHERE c.status = 'lapsed'
    ), '[]'::jsonb),
    'covers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'month', m.month, 'pool_id', p.id, 'pool_code', p.code, 'pool', p.name, 'amount', m.committee_covered_pkr,
        'voucher_no', v.voucher_no, 'at', m.covered_at,
        'by', (SELECT full_name FROM admin_users WHERE id = m.covered_by)
      ) ORDER BY m.covered_at DESC)
        FROM pool_months m JOIN support_pools p ON p.id = m.pool_id
        LEFT JOIN vouchers v ON v.id = m.covered_voucher_id
       WHERE m.committee_covered_pkr > 0
    ), '[]'::jsonb)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION pool_announcement_queue() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'pool_id', pl.id, 'pool_code', pl.code, 'pool', pl.name, 'donor_name',
    COALESCE((SELECT full_name FROM portal_users WHERE id = p.announced_by_portal_user_id),
             (SELECT donor_name FROM pool_commitments WHERE id = p.commitment_id)),
    'donor_phone',
    COALESCE((SELECT mobile FROM portal_users WHERE id = p.announced_by_portal_user_id),
             (SELECT donor_phone FROM pool_commitments WHERE id = p.commitment_id)),
    'amount', p.amount_pkr, 'is_one_time', p.is_one_time, 'month', p.for_month,
    'proof_url', p.proof_url, 'announced_at', p.announced_at
  ) ORDER BY p.announced_at), '[]'::jsonb)
  FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
  WHERE p.status = 'announced';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- Part B — a slip attached to every kind of Kafalat payment, not just some
-- ═════════════════════════════════════════════════════════════════════════
-- Transport and uniform payments already had a signature field but nowhere
-- to attach the actual photo of the receipt or the slip. This is the gap
-- between "somebody wrote their name down" and "there is a document behind
-- it a committee member could show an auditor."
ALTER TABLE kafalat_disbursements ADD COLUMN IF NOT EXISTS proof_url text;
ALTER TABLE kafalat_uniform_issues ADD COLUMN IF NOT EXISTS proof_url text;

CREATE OR REPLACE FUNCTION kafalat_pay_disbursement(
  p_disbursement_id uuid, p_method varchar, p_signed_by varchar DEFAULT NULL,
  p_driver_name varchar DEFAULT NULL, p_signed_note text DEFAULT NULL, p_proof_url text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  d kafalat_disbursements%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar;
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

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — ' || d.category || ', ' || to_char(d.month, 'Mon YYYY'),
    d.amount_pkr, v_cash, v_cash, COALESCE(p_driver_name, c.first_name), d.child_id, 'kafalat')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE kafalat_disbursements
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         recipient = CASE WHEN p_driver_name IS NOT NULL THEN 'driver' ELSE recipient END,
         driver_name = p_driver_name, signed_by = p_signed_by, signed_note = p_signed_note,
         proof_url = p_proof_url, voucher_id = v_voucher_id
   WHERE id = p_disbursement_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', d.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION kafalat_issue_uniform(
  p_issue_id uuid, p_received_by varchar, p_signed_note text DEFAULT NULL, p_method varchar DEFAULT 'cash',
  p_proof_url text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  u kafalat_uniform_issues%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO u FROM kafalat_uniform_issues WHERE id = p_issue_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF u.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This uniform is already %.', u.status USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(trim(p_received_by), '') = '' THEN
    RAISE EXCEPTION 'Name whoever received it — the child, the guardian, or the shop.'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = u.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — uniform ' || u.issue_no || '/2, ' || u.academic_year
      || CASE WHEN c.uniform_mode = 'cash' THEN ' (cash to guardian)' ELSE '' END,
    u.amount_pkr, v_cash, v_cash, c.first_name, u.child_id, 'kafalat')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE kafalat_uniform_issues
     SET status = 'issued', issued_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         received_by = p_received_by, signed_note = p_signed_note, proof_url = p_proof_url,
         voucher_id = v_voucher_id
   WHERE id = p_issue_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', u.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_pay_disbursement(uuid, varchar, varchar, varchar, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_pay_disbursement(uuid, varchar, varchar, varchar, text, text) TO authenticated;
REVOKE ALL ON FUNCTION kafalat_issue_uniform(uuid, varchar, text, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_issue_uniform(uuid, varchar, text, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Part C — school fee, books, medical, exam fee, tuition: budgeted, but
-- never actually payable. Uniform and transport had a real payment step;
-- these five package-line categories never got one at all.
-- ═════════════════════════════════════════════════════════════════════════
-- One line can be paid more than once — a fee is usually paid per term, not
-- as one lump sum — so this is its own table, not a column bolted onto
-- kafalat_package_lines.
CREATE TABLE IF NOT EXISTS kafalat_fee_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_line_id uuid NOT NULL REFERENCES kafalat_package_lines(id) ON DELETE CASCADE,
  child_id uuid NOT NULL REFERENCES kafalat_children(id) ON DELETE CASCADE,
  category varchar NOT NULL,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  paid_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Karachi')::date,
  method varchar CHECK (method IN ('cash', 'bank', 'jazzcash', 'easypaisa')),
  paid_to varchar,
  signed_by varchar,
  proof_url text,
  note text,
  voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kafalat_fee_payments_child_idx ON kafalat_fee_payments(child_id);

CREATE OR REPLACE FUNCTION kafalat_pay_fee_item(
  p_line_id uuid, p_amount decimal, p_method varchar, p_paid_to varchar DEFAULT NULL,
  p_signed_by varchar DEFAULT NULL, p_proof_url text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  l kafalat_package_lines%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_payment_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be more than zero.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM kafalat_package_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = l.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — ' || l.category || ', ' || l.academic_year
      || COALESCE(' — ' || p_paid_to, ''),
    p_amount, v_cash, v_cash, COALESCE(p_paid_to, c.first_name), l.child_id, 'kafalat')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
    paid_to, signed_by, proof_url, note, voucher_id, created_by)
  VALUES (p_line_id, l.child_id, l.category, p_amount, p_method, p_paid_to, p_signed_by,
    p_proof_url, p_note, v_voucher_id, current_admin_user_id())
  RETURNING id INTO v_payment_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'payment_id', v_payment_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_pay_fee_item(uuid, decimal, varchar, varchar, varchar, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_pay_fee_item(uuid, decimal, varchar, varchar, varchar, text, text) TO authenticated;

ALTER TABLE kafalat_fee_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kafalat_fee_payments_admin ON kafalat_fee_payments;
CREATE POLICY kafalat_fee_payments_admin ON kafalat_fee_payments FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
REVOKE ALL ON kafalat_fee_payments FROM anon;

-- Every fee line, paid or not, so the operations screen can show what's
-- still owed alongside what's already been settled.
CREATE OR REPLACE FUNCTION kafalat_fee_queue() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'line_id', l.id, 'child_id', l.child_id, 'child_code', c.code, 'child_name', c.first_name,
    'guardian', c.guardian_name, 'guardian_phone', c.guardian_phone,
    'category', l.category, 'description', l.description, 'academic_year', l.academic_year,
    'budgeted', l.annual_amount_pkr,
    'paid_so_far', COALESCE((SELECT SUM(amount_pkr) FROM kafalat_fee_payments WHERE package_line_id = l.id), 0)
  ) ORDER BY c.code, l.category), '[]'::jsonb)
  FROM kafalat_package_lines l JOIN kafalat_children c ON c.id = l.child_id
  WHERE l.category IN ('school_fee', 'books', 'medical', 'exam_fee', 'tuition', 'other')
    AND c.status = 'active' AND l.academic_year = kafalat_current_year();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_fee_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_fee_queue() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Part D — one child, one printable record: every rupee spent, what it
-- bought, who signed for it, and the total.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION kafalat_child_expense_record(p_child_id uuid, p_academic_year varchar DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  c kafalat_children%ROWTYPE; v_year varchar := COALESCE(p_academic_year, kafalat_current_year());
  v_lines jsonb; v_total decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'paid_on'), '[]'::jsonb), COALESCE(SUM((x->>'amount')::decimal), 0)
    INTO v_lines, v_total
  FROM (
    SELECT jsonb_build_object(
      'category', fp.category, 'amount', fp.amount_pkr, 'paid_on', fp.paid_on, 'method', fp.method,
      'paid_to', fp.paid_to, 'signed_by', fp.signed_by, 'proof_url', fp.proof_url, 'note', fp.note
    ) AS x
    FROM kafalat_fee_payments fp
    WHERE fp.child_id = p_child_id AND fp.paid_on BETWEEN kafalat_year_starts(v_year) AND kafalat_year_ends(v_year)
    UNION ALL
    SELECT jsonb_build_object(
      'category', 'uniform', 'amount', u.amount_pkr, 'paid_on', u.issued_on, 'method', 'cash',
      'paid_to', u.received_by, 'signed_by', u.received_by, 'proof_url', u.proof_url,
      'note', 'Uniform ' || u.issue_no || '/2' || COALESCE(' — ' || u.signed_note, '')
    ) AS x
    FROM kafalat_uniform_issues u
    WHERE u.child_id = p_child_id AND u.academic_year = v_year AND u.status = 'issued'
    UNION ALL
    SELECT jsonb_build_object(
      'category', d.category, 'amount', d.amount_pkr, 'paid_on', d.paid_on, 'method', d.method,
      'paid_to', COALESCE(d.driver_name, d.recipient), 'signed_by', d.signed_by, 'proof_url', d.proof_url,
      'note', to_char(d.month, 'Mon YYYY') || COALESCE(' — ' || d.signed_note, '')
    ) AS x
    FROM kafalat_disbursements d
    WHERE d.child_id = p_child_id AND d.status = 'paid'
      AND d.month BETWEEN kafalat_year_starts(v_year) AND kafalat_year_ends(v_year)
  ) rows;

  RETURN jsonb_build_object(
    'child_code', c.code, 'child_name', c.first_name, 'full_name', c.full_name,
    'guardian_name', c.guardian_name, 'guardian_phone', c.guardian_phone,
    'school_name', c.school_name, 'current_class', c.current_class,
    'academic_year', v_year, 'lines', v_lines, 'total_spent', v_total
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_child_expense_record(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_child_expense_record(uuid, varchar) TO authenticated;

-- Whole-programme total actually spent this year, across every child — the
-- figure the committee reports when someone asks "how much have we spent on
-- Kafalat".
CREATE OR REPLACE FUNCTION kafalat_total_spent(p_academic_year varchar DEFAULT NULL) RETURNS decimal AS $$
  SELECT COALESCE((
    SELECT SUM(amount_pkr) FROM kafalat_fee_payments
     WHERE paid_on BETWEEN kafalat_year_starts(COALESCE(p_academic_year, kafalat_current_year()))
                        AND kafalat_year_ends(COALESCE(p_academic_year, kafalat_current_year()))
  ), 0) + COALESCE((
    SELECT SUM(amount_pkr) FROM kafalat_uniform_issues
     WHERE status = 'issued' AND academic_year = COALESCE(p_academic_year, kafalat_current_year())
  ), 0) + COALESCE((
    SELECT SUM(amount_pkr) FROM kafalat_disbursements
     WHERE status = 'paid' AND month BETWEEN kafalat_year_starts(COALESCE(p_academic_year, kafalat_current_year()))
                                          AND kafalat_year_ends(COALESCE(p_academic_year, kafalat_current_year()))
  ), 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_total_spent(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_total_spent(varchar) TO authenticated;
