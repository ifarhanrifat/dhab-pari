-- Migration 092: disconnect_consumer() (migration 071) only ever flipped
-- consumers.status to 'disconnected' — nothing recorded WHEN. Needed for the
-- Running Capital monthly closing report's "disconnections this month" count.
-- Disconnections that happened before this migration have no recoverable
-- timestamp and will simply be excluded from historical month counts.
ALTER TABLE consumers ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;

CREATE OR REPLACE FUNCTION disconnect_consumer(p_consumer_id varchar) RETURNS jsonb AS $$
DECLARE
  v_consumer_account_id uuid;
  v_deposit_account_id uuid;
  v_cash_account_id uuid;
  v_consumer_name varchar;
  v_deposit_on_hand decimal;
  v_pending_balance decimal;
  v_applied decimal;
  v_refund decimal;
BEGIN
  IF NOT current_admin_permission('manage_parties') THEN
    RAISE EXCEPTION 'Only a user with consumer-management permission can disconnect a consumer';
  END IF;

  SELECT id, name INTO v_consumer_account_id, v_consumer_name FROM accounts WHERE type = 'consumer' AND consumer_id = p_consumer_id;
  IF v_consumer_account_id IS NULL THEN
    RAISE EXCEPTION 'No ledger account found for consumer %', p_consumer_id;
  END IF;

  SELECT id INTO v_deposit_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-5002';
  SELECT id INTO v_cash_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-1001';

  SELECT COALESCE(SUM(v.amount_pkr), 0) INTO v_deposit_on_hand
  FROM vouchers v WHERE v.voucher_type = 'security_deposit' AND v.status = 'posted'
    AND v.bill_id IN (SELECT id FROM bills WHERE consumer_id = p_consumer_id);
  v_deposit_on_hand := v_deposit_on_hand - COALESCE((
    SELECT SUM(v.amount_pkr) FROM vouchers v
    WHERE v.voucher_type = 'security_deposit_refund' AND v.status = 'posted' AND v.consumer_id = p_consumer_id
  ), 0);

  -- Debit-normal (consumer accounts are never credit-normal) — same rule the
  -- Chart of Accounts page's balanceOf() already applies.
  SELECT a.opening_balance + COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger_entries l WHERE l.account_id = a.id), 0)
  INTO v_pending_balance FROM accounts a WHERE a.id = v_consumer_account_id;

  v_applied := LEAST(v_deposit_on_hand, GREATEST(v_pending_balance, 0));
  v_refund := v_deposit_on_hand - v_applied;

  IF v_applied > 0 AND v_deposit_account_id IS NOT NULL THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, consumer_id, party_name)
    VALUES ('water_supply', 'security_deposit_refund', current_date,
      'Security deposit applied to outstanding balance — ' || v_consumer_name, v_applied,
      v_consumer_account_id, v_deposit_account_id, p_consumer_id, v_consumer_name);
  END IF;

  IF v_refund > 0 AND v_deposit_account_id IS NOT NULL AND v_cash_account_id IS NOT NULL THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, consumer_id, party_name)
    VALUES ('water_supply', 'security_deposit_refund', current_date,
      'Security deposit refund — ' || v_consumer_name, v_refund,
      v_cash_account_id, v_deposit_account_id, p_consumer_id, v_consumer_name);
  END IF;

  UPDATE consumers SET status = 'disconnected', disconnected_at = now() WHERE consumer_id = p_consumer_id;
  UPDATE accounts SET is_active = false WHERE id = v_consumer_account_id;
  UPDATE recurring_schedules SET is_active = false
    WHERE consumer_id = p_consumer_id AND schedule_type = 'bill' AND is_active = true;

  RETURN jsonb_build_object(
    'deposit_on_hand', v_deposit_on_hand, 'pending_balance', v_pending_balance,
    'applied', v_applied, 'refund', v_refund
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
