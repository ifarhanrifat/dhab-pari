-- Migration 013: Fix bill paid_amount/status recompute undercounting the current payment.
--
-- trg_payment_ledger runs BEFORE INSERT on payments, so its SUM(payments) query can't
-- see the row currently being inserted (it isn't committed yet) — every payment was
-- computing the bill's paid_amount as if it hadn't happened. This bug was never
-- exercised in practice until the billing page's recordPayment() was switched from a
-- direct bills UPDATE to inserting into payments (this session, alongside the
-- Receive Payment action added to the account statement page).

CREATE OR REPLACE FUNCTION trg_payment_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
  v_particular text;
BEGIN
  IF NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;
  v_account_id := ensure_consumer_account(NEW.consumer_id);
  v_particular := 'Payment received (' || NEW.method || ')';

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_account_id, NEW.paid_date, v_particular, 0, NEW.amount_pkr, 'payment', NEW.id);

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'water_supply' AND code = (CASE WHEN NEW.method = 'cash' THEN 'WS-1001' ELSE 'WS-1002' END);
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cash_account_id, NEW.paid_date, v_particular, NEW.amount_pkr, 0, 'payment', NEW.id);
  END IF;

  SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id;
  -- This row hasn't been committed yet (still BEFORE INSERT), so add it explicitly —
  -- the SUM below only sees payments that already existed before this one.
  SELECT COALESCE(SUM(amount_pkr), 0) + NEW.amount_pkr INTO v_total_paid FROM payments WHERE bill_id = NEW.bill_id;

  UPDATE bills SET
    paid_amount = v_total_paid,
    status = CASE WHEN v_total_paid >= v_bill.amount_pkr THEN 'paid'
                  WHEN v_total_paid > 0 THEN 'partial'
                  ELSE v_bill.status END,
    paid_date = NEW.paid_date,
    payment_method = NEW.method
  WHERE id = NEW.bill_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recompute paid_amount/status for every existing bill from its actual payment history,
-- fixing any bill whose stored paid_amount undercounted due to the bug above.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id, amount_pkr, status FROM bills LOOP
    DECLARE
      v_total decimal;
    BEGIN
      SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total FROM payments WHERE bill_id = r.id;
      IF v_total > 0 THEN
        UPDATE bills SET
          paid_amount = v_total,
          status = CASE WHEN v_total >= r.amount_pkr THEN 'paid' ELSE 'partial' END
        WHERE id = r.id;
      END IF;
    END;
  END LOOP;
END $$;
