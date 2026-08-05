-- Migration 090: an Advance Settlement's real economic effect is an expense
-- (funded via a pre-existing advance instead of straight cash-out) — its line
-- items already debit real expense accounts correctly in post_voucher_ledger_legs
-- (migration 083), so account-level reports were always accurate. But the
-- voucher itself was numbered from its own WS-ADVS-V series and labeled
-- "Advance Settlement" everywhere, so it never showed up under the Expense
-- type/filter the way the user expects a Rs. X expense to. This keeps
-- 'advance_settlement' as the internal voucher_type (post_voucher_ledger_legs
-- still needs it to know to clear the linked advance), but numbers it from
-- the same counter as a plain expense voucher, so it reads as a normal
-- expense voucher number everywhere.

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
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, CASE WHEN NEW.voucher_type = 'advance_settlement' THEN 'expense' ELSE NEW.voucher_type END));
  END IF;

  IF NEW.voucher_type IN ('security_deposit', 'security_deposit_refund') AND NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_voucher_after_approval() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'posted' THEN
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, CASE WHEN NEW.voucher_type = 'advance_settlement' THEN 'expense' ELSE NEW.voucher_type END));
    PERFORM post_voucher_ledger_legs(NEW);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
      voucher_no = COALESCE(voucher_no, next_voucher_no(v.system, CASE WHEN v.voucher_type = 'advance_settlement' THEN 'expense' ELSE v.voucher_type END))
      WHERE id = p_voucher_id;
  ELSE
    UPDATE vouchers SET amount_pkr = v_line_total, status = v_new_status WHERE id = p_voucher_id;
    PERFORM create_approval_request(v.system, 'voucher', v.id, v.particular, v_line_total, current_admin_user_id());
  END IF;

  RETURN jsonb_build_object('status', v_new_status, 'amount', v_line_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill: renumber existing advance_settlement vouchers off the expense
-- counter so already-recorded settlements (e.g. Muhammad Khan, Rs. 8700)
-- also show a proper expense voucher number instead of WS-ADVS-V-....
DO $$
DECLARE r RECORD; v_no varchar;
BEGIN
  FOR r IN SELECT id FROM vouchers WHERE voucher_type = 'advance_settlement' AND voucher_no LIKE 'WS-ADVS-V%' ORDER BY created_at LOOP
    SELECT next_voucher_no('water_supply', 'expense') INTO v_no;
    UPDATE vouchers SET voucher_no = v_no WHERE id = r.id;
  END LOOP;
END $$;
