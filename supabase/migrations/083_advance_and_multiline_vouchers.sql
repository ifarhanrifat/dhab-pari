-- Migration 083: Three related additions to the voucher system.
--
--   1. Multi-category Expense — one cash-out event split across several
--      expense accounts in a single voucher (voucher_line_items), instead of
--      one account per voucher.
--   2. Attachment support on vouchers (mirrors purchases.attachment_url),
--      so an approver can actually see the bill being approved.
--   3. Advance-to-Worker workflow — solves the real problem where cash goes
--      out to a repair worker days/weeks before the real itemized bill shows
--      up. The advance itself posts immediately as a normal, complete,
--      balanced transaction (Dr Advance / Cr Cash) — nothing about the cash
--      movement is ever "pending". What's deferred is only the final
--      categorization, which happens later in ONE settlement voucher that:
--        - debits the real itemized expense accounts (with the real bill
--          attached, so THIS is the transaction that goes to approval with
--          real data),
--        - credits the advance account for the full original advance amount
--          (clearing it),
--        - and picks up the remaining difference as one more leg: cash IN if
--          the bill came in under the advance (worker hands back the
--          balance), or cash OUT if it came in over (committee tops up).
--      This is standard double-entry (an "Advance to Employee/Supplier"
--      receivable) — not a half-finished transaction.
--
-- Multi-leg vouchers (multi-category expense, or a settlement) can't post
-- their ledger legs at INSERT time the normal way, because the line items
-- (which determine the real amount and the accounts involved) don't exist
-- until after the voucher row itself exists (they reference its id). So
-- these insert as status='draft' (skips the normal approval/posting
-- decision entirely), then a finalize_voucher() call — once line items are
-- attached — decides pending vs. posted and actually ledgers it. Simple
-- single-account vouchers (Income, Contra, Deposit, Security Deposit, a
-- plain Advance payout) are completely unaffected — they still insert
-- directly with their real status like today.

INSERT INTO accounts (code, name, type, system, description, is_protected) VALUES
  ('WS-4003', 'Advance to Workers/Contractors', 'asset', 'water_supply', 'Cash advanced to repair workers/contractors before their bill is submitted', true)
ON CONFLICT (code, system) DO NOTHING;

ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_voucher_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_voucher_type_check
  CHECK (voucher_type IN ('expense', 'income', 'contra', 'withdrawal', 'deposit', 'security_deposit', 'security_deposit_refund', 'advance', 'advance_settlement'));

ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_status_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_status_check
  CHECK (status IN ('draft', 'pending', 'posted', 'approved', 'rejected'));

ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS attachment_url text;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS settles_voucher_id uuid REFERENCES vouchers(id);

CREATE TABLE IF NOT EXISTS voucher_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount decimal NOT NULL CHECK (amount > 0),
  description text
);
ALTER TABLE voucher_line_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "voucher_line_items_read" ON voucher_line_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vouchers v WHERE v.id = voucher_id AND can_access_system(v.system)));
CREATE POLICY "voucher_line_items_write" ON voucher_line_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM vouchers v WHERE v.id = voucher_id AND can_access_system(v.system) AND current_admin_permission('post_transactions')));

-- Shared by both posting paths (direct-post and approval-completion) so the
-- multi-leg logic only lives in one place.
CREATE OR REPLACE FUNCTION voucher_requires_approval(p_system varchar, p_voucher_type varchar) RETURNS boolean AS $$
DECLARE
  v_requires boolean;
  v_has_approvers boolean;
BEGIN
  v_requires := p_voucher_type IN ('withdrawal', 'expense', 'advance', 'advance_settlement')
    AND approval_type_enabled(p_system, CASE WHEN p_voucher_type = 'withdrawal' THEN 'withdrawal' ELSE 'expense' END);
  IF v_requires THEN
    SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = p_system AND is_active = true) INTO v_has_approvers;
    v_requires := v_has_approvers;
  END IF;
  RETURN v_requires;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION post_voucher_ledger_legs(p_voucher vouchers) RETURNS void AS $$
DECLARE
  v_bill_number varchar;
  v_line_total decimal;
  v_advance_amount decimal;
  v_diff decimal;
  v_advance_account_id uuid;
  r RECORD;
BEGIN
  IF p_voucher.bill_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = p_voucher.bill_id;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_line_total FROM voucher_line_items WHERE voucher_id = p_voucher.id;

  IF p_voucher.voucher_type = 'advance_settlement' THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;

    SELECT amount_pkr INTO v_advance_amount FROM vouchers WHERE id = p_voucher.settles_voucher_id;
    v_diff := v_advance_amount - v_line_total; -- > 0: refund received; < 0: extra paid

    SELECT id INTO v_advance_account_id FROM accounts WHERE system = p_voucher.system AND code = 'WS-4003';
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_advance_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_advance_amount, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);

    IF v_diff > 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, v_diff, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    ELSIF v_diff < 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, -v_diff, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END IF;

    UPDATE vouchers SET settled_at = now() WHERE id = p_voucher.settles_voucher_id;

  ELSIF v_line_total > 0 THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_line_total, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);

  ELSE
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, p_voucher.particular, p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_voucher_before_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF voucher_requires_approval(NEW.system, NEW.voucher_type) THEN
    NEW.status := 'pending';
    NEW.voucher_no := NULL;
  ELSE
    NEW.status := 'posted';
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
  END IF;

  IF NEW.voucher_type IN ('security_deposit', 'security_deposit_refund') AND NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_voucher_ledger() RETURNS trigger AS $$
BEGIN
  -- The pending -> posted transition (approval granted) is handled entirely
  -- by trg_voucher_after_approval below — skip here to avoid posting twice.
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' THEN
    RETURN NEW;
  END IF;
  IF NEW.status != 'posted' THEN
    RETURN NEW;
  END IF;
  PERFORM post_voucher_ledger_legs(NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS voucher_ledger_trigger ON vouchers;
CREATE TRIGGER voucher_ledger_trigger AFTER INSERT OR UPDATE OF status ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_voucher_ledger();

CREATE OR REPLACE FUNCTION trg_voucher_after_approval() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'posted' THEN
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
    PERFORM post_voucher_ledger_legs(NEW);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Draft -> pending/posted, once line items are attached. Recomputes the real
-- amount from the line items and makes the same approval decision every
-- other voucher type already goes through.
CREATE OR REPLACE FUNCTION finalize_voucher(p_voucher_id uuid) RETURNS jsonb AS $$
DECLARE
  v vouchers%ROWTYPE;
  v_line_total decimal;
  v_new_status varchar;
BEGIN
  IF NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to post this transaction';
  END IF;

  SELECT * INTO v FROM vouchers WHERE id = p_voucher_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Voucher not found'; END IF;
  IF v.status != 'draft' THEN RAISE EXCEPTION 'Voucher is already finalized'; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_line_total FROM voucher_line_items WHERE voucher_id = p_voucher_id;
  IF v_line_total <= 0 THEN RAISE EXCEPTION 'Add at least one line item first'; END IF;

  v_new_status := CASE WHEN voucher_requires_approval(v.system, v.voucher_type) THEN 'pending' ELSE 'posted' END;

  IF v_new_status = 'posted' THEN
    UPDATE vouchers SET amount_pkr = v_line_total, status = v_new_status,
      voucher_no = COALESCE(voucher_no, next_voucher_no(v.system, v.voucher_type))
      WHERE id = p_voucher_id;
  ELSE
    UPDATE vouchers SET amount_pkr = v_line_total, status = v_new_status WHERE id = p_voucher_id;
    PERFORM create_approval_request(v.system, 'voucher', v.id, v.particular, v_line_total, current_admin_user_id());
  END IF;

  RETURN jsonb_build_object('status', v_new_status, 'amount', v_line_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION finalize_voucher(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_voucher(uuid) TO authenticated;
