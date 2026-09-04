-- Migration 441: waive_bill() (438) set bills.discount_amount = amount_pkr
-- so every screen that computes "net payable" from that column already
-- reads Rs 0 -- but the consumer's actual double-entry ledger never heard
-- about it. trg_bill_ledger (300) only fires
-- `AFTER INSERT OR UPDATE OF amount_pkr, month, year` -- discount_amount
-- is not one of those columns, by design, because normally a discount is
-- set once, at generation time, before the row is ever inserted. A
-- waiver sets it afterward, on an already-posted bill, so the trigger
-- never re-runs and the original full-amount debit to the consumer's
-- account sits there untouched forever. Caught checking the consumer's
-- own account statement (accounts/[id]) against what billBadge() said --
-- the statement still showed the bill as fully outstanding.
--
-- The fix mirrors exactly what the trigger itself posts for an ordinary
-- discount with no inventory lines (100% to "Discount Given", WS-3008 --
-- literally described as "Discounts/waivers granted on consumer bills"
-- since 035): debit the expense account, credit the consumer's account,
-- for the amount actually forgiven. That nets the consumer's ledger
-- balance for this bill to Rs 0, same as everywhere else already reads it.
-- Dated today (not the bill's own period) -- like a voucher reversal,
-- this is a distinct decision made later, not a correction to what the
-- bill originally said.
CREATE OR REPLACE FUNCTION waive_bill(p_bill_id uuid, p_reason text) RETURNS void AS $$
DECLARE
  b bills%ROWTYPE; v_admin_id uuid := current_admin_user_id();
  v_account_id uuid; v_discount_account_id uuid; v_waived_amount decimal; v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Give a reason for the waiver -- it is the only record of why this bill was forgiven.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO b FROM bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'waived' THEN RAISE EXCEPTION 'This bill is already waived.' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(b.paid_amount, 0) > 0 THEN
    RAISE EXCEPTION 'This bill already has a payment recorded -- a waiver only applies to a bill nothing has been paid on yet.' USING ERRCODE = 'P0001';
  END IF;

  v_waived_amount := b.amount_pkr - COALESCE(b.discount_amount, 0);

  UPDATE bills SET
    discount_amount = amount_pkr,
    status = 'waived', waived_at = now(), waived_by_admin_id = v_admin_id, waived_reason = trim(p_reason)
  WHERE id = p_bill_id;

  IF v_waived_amount > 0 THEN
    v_account_id := ensure_consumer_account(b.consumer_id);
    SELECT id INTO v_discount_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-3008';
    IF v_discount_account_id IS NOT NULL THEN
      v_particular := 'Waived -- Bill #' || COALESCE(b.bill_number, '') || ' -- ' || trim(p_reason);
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_discount_account_id, (now() AT TIME ZONE 'Asia/Karachi')::date, v_particular, v_waived_amount, 0, 'bill', b.id, b.bill_number);
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_account_id, (now() AT TIME ZONE 'Asia/Karachi')::date, v_particular, 0, v_waived_amount, 'bill', b.id, b.bill_number);
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
