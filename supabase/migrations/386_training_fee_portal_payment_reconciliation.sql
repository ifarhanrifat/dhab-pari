-- Migration 386: closes the real gap found while explaining the academy
-- reporting flow — a parent paying their child's fee through the portal
-- (rather than handing cash to the trainer) had no way to link that
-- payment back to the specific training_fee_charges row. It posted as a
-- perfectly good donation, but the charge itself sat "due"/"overdue"
-- forever unless an admin separately noticed and re-entered it by hand
-- via pay_training_fee_charge() — real risk of double-posting the same
-- money, and a parent who'd genuinely paid kept being told they hadn't.
--
-- Same announce → confirm shape every other payment path in this app
-- already uses (donors.is_verified, pool_payments, wazifa) — a portal
-- payment is "announced" against one specific charge; the ledger only
-- posts once staff confirms it, exactly like pay_training_fee_charge()
-- already does for a trainer's in-person collection, just triggered from
-- confirmation instead of direct entry.

ALTER TABLE training_fee_charges DROP CONSTRAINT IF EXISTS training_fee_charges_status_check;
ALTER TABLE training_fee_charges ADD CONSTRAINT training_fee_charges_status_check
  CHECK (status IN ('due', 'part_paid', 'paid', 'waived', 'announced'));

ALTER TABLE training_fee_charges
  ADD COLUMN IF NOT EXISTS announced_amount_pkr decimal,
  ADD COLUMN IF NOT EXISTS announced_method varchar,
  ADD COLUMN IF NOT EXISTS announced_proof_url text,
  ADD COLUMN IF NOT EXISTS announced_at timestamptz;

-- ── Portal: announce a payment against one specific charge ───────────────
CREATE OR REPLACE FUNCTION announce_training_fee_payment(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_proof_url text
) RETURNS void AS $$
DECLARE
  c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  v_remaining decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;
  IF e.portal_user_id IS DISTINCT FROM v_portal_user_id THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF c.status IN ('paid', 'announced') THEN
    RAISE EXCEPTION 'This charge already has a payment recorded or awaiting confirmation.' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this charge.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  UPDATE training_fee_charges
     SET status = 'announced', announced_amount_pkr = p_amount, announced_method = p_method,
         announced_proof_url = p_proof_url, announced_at = now()
   WHERE id = p_charge_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION announce_training_fee_payment(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION announce_training_fee_payment(uuid, decimal, varchar, text) TO authenticated;

-- ── Staff: confirm it — the only place a training fee's ledger legs get
--    posted from a portal payment, same accounts pay_training_fee_charge()
--    posts to for a direct collection (always the real cash/bank account
--    here, never a collector's clearing account — this was a bank
--    transfer the parent made themselves, not cash handed to a trainer).
CREATE OR REPLACE FUNCTION confirm_training_fee_announcement(p_charge_id uuid) RETURNS jsonb AS $$
DECLARE
  c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE; proj projects%ROWTYPE;
  v_from_account uuid; v_project_account uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_amount decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status <> 'announced' THEN RAISE EXCEPTION 'No payment is awaiting confirmation on this charge.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;
  SELECT * INTO proj FROM projects WHERE id = e.project_id;
  v_project_account := ensure_project_account(e.project_id);
  v_amount := c.announced_amount_pkr;

  SELECT id INTO v_from_account FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN c.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  -- from_account_id = the project (credited — money arriving), to_account_id
  -- = cash/bank (debited — asset increase), same convention as
  -- pay_training_fee_charge().
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, project_id)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    e.student_name || ' — training fee, charge ' || c.charge_no || ' (' || COALESCE(proj.display_name, proj.title) || ') · paid via portal, confirmed',
    v_amount, v_project_account, v_from_account, e.student_name, e.project_id)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE training_fee_charges
     SET paid_pkr = paid_pkr + v_amount,
         status = CASE WHEN paid_pkr + v_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = c.announced_method,
         voucher_id = v_voucher_id, collected_by = NULL
   WHERE id = p_charge_id;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'training_fee_payment_confirmed', 'Payment confirmed',
      'Your payment for ' || e.student_name || ' (' || COALESCE(proj.display_name, proj.title) || ') has been confirmed.', '/portal/training-programs');
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', v_amount, 'charge_id', p_charge_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION confirm_training_fee_announcement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_training_fee_announcement(uuid) TO authenticated;

-- ── Staff: reject it — e.g. the slip doesn't match, wrong amount, never
--    arrived. Falls back to whatever the charge's real status already
--    was (recomputed from paid_pkr, not just reset to 'due' — a
--    part-paid charge with a rejected top-up announcement should land
--    back on 'part_paid', not lose its existing payment history).
CREATE OR REPLACE FUNCTION reject_training_fee_announcement(p_charge_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE; proj projects%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status <> 'announced' THEN RAISE EXCEPTION 'No payment is awaiting confirmation on this charge.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;
  SELECT * INTO proj FROM projects WHERE id = e.project_id;

  UPDATE training_fee_charges
     SET status = CASE WHEN paid_pkr >= amount_pkr - 0.01 THEN 'paid' WHEN paid_pkr > 0 THEN 'part_paid' ELSE 'due' END,
         announced_amount_pkr = NULL, announced_method = NULL, announced_proof_url = NULL, announced_at = NULL,
         note = COALESCE(note || ' · ', '') || 'Announced payment rejected' || COALESCE(': ' || p_reason, '')
   WHERE id = p_charge_id;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'training_fee_payment_rejected', 'Payment could not be confirmed',
      'Your payment for ' || e.student_name || ' (' || COALESCE(proj.display_name, proj.title) || ') could not be confirmed.' || COALESCE(' ' || p_reason, ''),
      '/portal/training-programs');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION reject_training_fee_announcement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reject_training_fee_announcement(uuid, text) TO authenticated;

-- my_training_fees(): due_soon now includes 'announced' charges (so a
-- parent who's paid sees "awaiting confirmation", not still "due"), and
-- carries the announced amount so the portal can show it.
CREATE OR REPLACE FUNCTION my_training_fees() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'enrollment_id', e.id, 'project_id', e.project_id, 'status', e.status,
    'program_title', COALESCE(proj.display_name, proj.title), 'batch_label', bat.label, 'student_name', e.student_name,
    'fee_type', e.fee_type, 'monthly_amount_pkr', e.fee_amount_pkr, 'rejected_reason', e.rejected_reason,
    'due_soon', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', c.id, 'due_on', c.due_on, 'amount', c.amount_pkr, 'paid', c.paid_pkr, 'status', c.status,
        'announced_amount_pkr', c.announced_amount_pkr
      ) ORDER BY c.due_on), '[]'::jsonb) FROM training_fee_charges c
      WHERE c.enrollment_id = e.id AND c.status IN ('due', 'part_paid', 'announced')),
    'total_paid', (SELECT COALESCE(SUM(paid_pkr), 0) FROM training_fee_charges WHERE enrollment_id = e.id),
    'total_overdue', (SELECT COALESCE(SUM(amount_pkr - paid_pkr), 0) FROM training_fee_charges
      WHERE enrollment_id = e.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date)
  ) ORDER BY e.enrolled_at DESC), '[]'::jsonb)
  FROM training_enrollments e
  JOIN projects proj ON proj.id = e.project_id
  LEFT JOIN training_batches bat ON bat.id = e.batch_id
  WHERE e.portal_user_id = current_portal_user_id() AND e.status IN ('pending', 'active', 'rejected');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
