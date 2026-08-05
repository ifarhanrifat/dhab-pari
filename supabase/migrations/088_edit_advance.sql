-- Migration 088: the Advance Payments tab was always missing its Edit action
-- (only Settle/Delete existed). An advance posts its ledger entry immediately
-- at creation, so a plain field UPDATE would leave the ledger showing the old
-- amount/account — this function deletes the voucher's existing ledger
-- entries and reposts via the same post_voucher_ledger_legs() every other
-- voucher path already uses, so the repost logic isn't duplicated client-side.
-- Only unsettled advances may be edited — settled_at is a server-side guard,
-- not just a UI hide, since the settlement voucher already carries a
-- snapshot of the original amount (v_advance_amount in post_voucher_ledger_legs).
CREATE OR REPLACE FUNCTION edit_advance(
  p_voucher_id uuid, p_amount decimal, p_from_account_id uuid,
  p_particular text, p_voucher_date date, p_party_name varchar
) RETURNS void AS $$
DECLARE
  v vouchers%ROWTYPE;
BEGIN
  IF NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to edit this transaction';
  END IF;

  SELECT * INTO v FROM vouchers WHERE id = p_voucher_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found'; END IF;
  IF v.voucher_type != 'advance' THEN RAISE EXCEPTION 'Not an advance voucher'; END IF;
  IF v.settled_at IS NOT NULL THEN RAISE EXCEPTION 'This advance has already been settled and cannot be edited'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;

  DELETE FROM ledger_entries WHERE reference_type = 'voucher' AND reference_id = p_voucher_id;

  UPDATE vouchers SET
    amount_pkr = p_amount, from_account_id = p_from_account_id,
    particular = p_particular, voucher_date = p_voucher_date, party_name = p_party_name
    WHERE id = p_voucher_id
    RETURNING * INTO v;

  IF v.status = 'posted' THEN
    PERFORM post_voucher_ledger_legs(v);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION edit_advance(uuid, decimal, uuid, text, date, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edit_advance(uuid, decimal, uuid, text, date, varchar) TO authenticated;
