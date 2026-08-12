-- Migration 204: stop a settled bill being rewritten, and close past months.
--
-- ═════════════════════════════════════════════════════════════════════════
-- What was wrong
-- ═════════════════════════════════════════════════════════════════════════
-- Bills are edited and deleted straight from the browser:
--
--     supabase.from('bills').update(...)
--     supabase.from('bills').delete().eq('id', id)
--
-- with nothing on the server checking whether the money had already come in.
-- Verified against the live database: bills 4/2024, 6/2024 and 4/2024 are all
-- status='paid' with receipts 0029, 0060 and 0015 against them, and every one
-- of them is editable and deletable today.
--
-- Deleting is the worse half. payments.bill_id is
--
--     REFERENCES bills(id) ON DELETE CASCADE
--
-- so removing a paid bill silently removes the payment rows recording cash the
-- committee actually holds. The receipt exists on paper in somebody's hand and
-- nowhere in the books. Nothing warns, nothing logs it as unusual, and the cash
-- position quietly changes.
--
-- Editing is subtler and just as bad: change the amount of a bill that has been
-- paid in full and it becomes underpaid or overpaid retrospectively, with no
-- record that the figure ever moved.
--
-- ═════════════════════════════════════════════════════════════════════════
-- 1. A bill with money against it is closed to edits
-- ═════════════════════════════════════════════════════════════════════════
-- The rule the committee asked for: to change a settled bill you must first
-- delete its receipt, which is itself a deliberate, logged act. The error names
-- the receipt so the accountant knows exactly what to remove — being told "you
-- cannot edit this" without being told why or what to do next is how people end
-- up deleting the whole bill instead.
CREATE OR REPLACE FUNCTION bill_payment_block(p_bill_id uuid)
RETURNS text AS $$
  SELECT string_agg(receipt_no, ', ' ORDER BY receipt_no)
    FROM payments WHERE bill_id = p_bill_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trg_bills_protect_settled() RETURNS trigger AS $$
DECLARE
  v_receipts text;
  v_locked boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Marking a bill paid, or attaching its own voucher, is the payment flow
    -- doing its job — not a human rewriting history. Only the figures and the
    -- period are protected.
    IF NEW.amount_pkr IS NOT DISTINCT FROM OLD.amount_pkr
       AND NEW.discount_amount IS NOT DISTINCT FROM OLD.discount_amount
       AND NEW.month IS NOT DISTINCT FROM OLD.month
       AND NEW.year IS NOT DISTINCT FROM OLD.year
       AND NEW.consumer_id IS NOT DISTINCT FROM OLD.consumer_id THEN
      RETURN NEW;
    END IF;
  END IF;

  v_receipts := bill_payment_block(COALESCE(OLD.id, NEW.id));
  IF v_receipts IS NOT NULL THEN
    RAISE EXCEPTION
      'This bill has already been paid — receipt %. Delete that receipt first, then the bill can be changed.',
      v_receipts
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bills_protect_settled ON bills;
CREATE TRIGGER bills_protect_settled
  BEFORE UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION trg_bills_protect_settled();

-- Belt and braces on the cascade itself. Even with the trigger above, a future
-- delete path that bypasses it must not be able to take payment rows with it.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_bill_id_fkey;
ALTER TABLE payments ADD CONSTRAINT payments_bill_id_fkey
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE RESTRICT;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Past months close
-- ═════════════════════════════════════════════════════════════════════════
-- An accountant editing last month's figures changes a month that has already
-- been reported, reconciled and shown to the committee. The correction has to
-- be visible, so it happens in the current month as its own entry rather than
-- by quietly rewriting a closed one.
--
-- Which months are open is a setting, not a hard rule: a committee that closes
-- its books on the 10th needs the previous month to stay open until then.
INSERT INTO site_settings (key, value) VALUES
  ('period_lock_enabled', 'true'),
  -- Days into the new month during which the previous month stays editable.
  ('period_lock_grace_days', '10')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION period_is_locked(p_date date) RETURNS boolean AS $$
DECLARE
  v_enabled boolean;
  v_grace int;
  v_today date;
  v_cutoff date;
BEGIN
  SELECT COALESCE((SELECT value FROM site_settings WHERE key = 'period_lock_enabled'), 'true') = 'true'
    INTO v_enabled;
  IF NOT v_enabled OR p_date IS NULL THEN RETURN false; END IF;

  SELECT COALESCE((SELECT value FROM site_settings WHERE key = 'period_lock_grace_days'), '10')::int
    INTO v_grace;

  -- Pakistan's calendar, not the server's UTC one: on the 1st of a month the
  -- server can still be on the 31st, which would lock a month a day early.
  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;

  -- Everything before the 1st of the current month is closed, except during
  -- the grace window, when the previous month is still open too.
  v_cutoff := date_trunc('month', v_today)::date;
  IF EXTRACT(DAY FROM v_today)::int <= v_grace THEN
    v_cutoff := (date_trunc('month', v_today) - interval '1 month')::date;
  END IF;

  RETURN p_date < v_cutoff;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION period_is_locked(date) TO authenticated;

-- Super admins can still act in a closed month — somebody has to be able to
-- fix a genuine mistake — but it is deliberate, and the audit log records who.
CREATE OR REPLACE FUNCTION assert_period_open(p_date date, p_what text DEFAULT 'this entry')
RETURNS void AS $$
BEGIN
  IF period_is_locked(p_date) AND current_admin_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION
      '% falls in a closed month (%). Closed months cannot be changed — post a journal voucher in the current month instead.',
      p_what, to_char(p_date, 'Mon YYYY')
      USING ERRCODE = 'P0001';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION assert_period_open(date, text) TO authenticated;

CREATE OR REPLACE FUNCTION trg_period_lock_vouchers() RETURNS trigger AS $$
BEGIN
  -- The date being left alone is checked as well as the new one, so a locked
  -- entry cannot be dragged forward into an open month to edit it.
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_period_open(OLD.voucher_date, 'This voucher');
    RETURN OLD;
  END IF;
  PERFORM assert_period_open(NEW.voucher_date, 'This voucher');
  IF TG_OP = 'UPDATE' THEN PERFORM assert_period_open(OLD.voucher_date, 'This voucher'); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS period_lock_vouchers ON vouchers;
CREATE TRIGGER period_lock_vouchers
  BEFORE INSERT OR UPDATE OR DELETE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_period_lock_vouchers();

CREATE OR REPLACE FUNCTION trg_period_lock_payments() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_period_open(OLD.payment_date, 'This receipt');
    RETURN OLD;
  END IF;
  PERFORM assert_period_open(NEW.payment_date, 'This receipt');
  IF TG_OP = 'UPDATE' THEN PERFORM assert_period_open(OLD.payment_date, 'This receipt'); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS period_lock_payments ON payments;
CREATE TRIGGER period_lock_payments
  BEFORE INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_period_lock_payments();

-- Donations carry a date and post to the ledger, so they close the same way.
CREATE OR REPLACE FUNCTION trg_period_lock_donors() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_period_open(OLD.date, 'This donation');
    RETURN OLD;
  END IF;
  -- An unverified pledge is not yet in the books; only confirmed money is
  -- period-locked.
  IF TG_OP = 'UPDATE' AND NEW.is_verified = false AND OLD.is_verified = false THEN
    RETURN NEW;
  END IF;
  PERFORM assert_period_open(NEW.date, 'This donation');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS period_lock_donors ON donors;
CREATE TRIGGER period_lock_donors
  BEFORE UPDATE OR DELETE ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_period_lock_donors();

-- Lets a screen grey out its Edit and Delete buttons rather than offering an
-- action that will be refused.
CREATE OR REPLACE FUNCTION bill_edit_state(p_bill_id uuid)
RETURNS TABLE (can_edit boolean, blocking_receipts text, period_locked boolean) AS $$
  SELECT
    bill_payment_block(b.id) IS NULL AND NOT period_is_locked(make_date(b.year, b.month, 1)),
    bill_payment_block(b.id),
    period_is_locked(make_date(b.year, b.month, 1))
  FROM bills b WHERE b.id = p_bill_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION bill_edit_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bill_edit_state(uuid) TO authenticated;
