-- Migration 072: Read-only preview of what Permanent Disconnection would settle,
-- sharing the exact same computation disconnect_consumer() uses so the number
-- shown to the accountant before confirming can never drift from what actually
-- posts.
CREATE OR REPLACE FUNCTION preview_disconnect_consumer(p_consumer_id varchar) RETURNS jsonb AS $$
DECLARE
  v_consumer_account_id uuid;
  v_deposit_on_hand decimal;
  v_pending_balance decimal;
  v_applied decimal;
  v_refund decimal;
BEGIN
  IF NOT can_access_system('water_supply') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT id INTO v_consumer_account_id FROM accounts WHERE type = 'consumer' AND consumer_id = p_consumer_id;
  IF v_consumer_account_id IS NULL THEN
    RAISE EXCEPTION 'No ledger account found for consumer %', p_consumer_id;
  END IF;

  SELECT COALESCE(SUM(v.amount_pkr), 0) INTO v_deposit_on_hand
  FROM vouchers v WHERE v.voucher_type = 'security_deposit' AND v.status = 'posted'
    AND v.bill_id IN (SELECT id FROM bills WHERE consumer_id = p_consumer_id);
  v_deposit_on_hand := v_deposit_on_hand - COALESCE((
    SELECT SUM(v.amount_pkr) FROM vouchers v
    WHERE v.voucher_type = 'security_deposit_refund' AND v.status = 'posted' AND v.consumer_id = p_consumer_id
  ), 0);

  SELECT a.opening_balance + COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger_entries l WHERE l.account_id = a.id), 0)
  INTO v_pending_balance FROM accounts a WHERE a.id = v_consumer_account_id;

  v_applied := LEAST(v_deposit_on_hand, GREATEST(v_pending_balance, 0));
  v_refund := v_deposit_on_hand - v_applied;

  RETURN jsonb_build_object(
    'deposit_on_hand', v_deposit_on_hand, 'pending_balance', v_pending_balance,
    'applied', v_applied, 'refund', v_refund
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION preview_disconnect_consumer(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION preview_disconnect_consumer(varchar) TO authenticated;
