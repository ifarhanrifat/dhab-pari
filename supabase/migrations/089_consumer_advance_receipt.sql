-- Migration 089: lets a consumer pay in advance (prepay before any bill exists,
-- or beyond what's currently owed) directly through Cash Receipt. Previously
-- payments.bill_id was NOT NULL, so every payment had to reference a real
-- bill — there was no way to record cash received with nothing outstanding
-- to apply it to. The consumer's own account already treats a negative
-- balance as an "advance" (see accounts/[id] page), so this reuses that same
-- mechanism instead of inventing a parallel one.
ALTER TABLE payments ALTER COLUMN bill_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION trg_payment_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
  v_net_payable decimal;
  v_status_note text;
  v_particular text;
  v_collector_name varchar;
BEGIN
  IF NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;
  v_account_id := ensure_consumer_account(NEW.consumer_id);

  IF NEW.collected_by IS NOT NULL THEN
    SELECT full_name INTO v_collector_name FROM admin_users WHERE id = NEW.collected_by;
  END IF;

  IF NEW.bill_id IS NULL THEN
    v_particular := 'Advance / Prepayment received (' || NEW.method || ')'
      || CASE WHEN v_collector_name IS NOT NULL THEN ' via collector ' || v_collector_name ELSE '' END
      || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;
  ELSE
    SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id;
    SELECT COALESCE(SUM(amount_pkr), 0) + NEW.amount_pkr INTO v_total_paid
      FROM payments WHERE bill_id = NEW.bill_id;
    v_net_payable := v_bill.amount_pkr - COALESCE(v_bill.discount_amount, 0);

    v_status_note := CASE
      WHEN v_total_paid >= v_net_payable THEN 'Bill Paid in Full'
      ELSE 'Partial Payment — Rs. ' || to_char(v_net_payable - v_total_paid, 'FM999999990.00') || ' remaining'
    END;

    v_particular := 'Payment received (' || NEW.method || ')'
      || CASE WHEN v_collector_name IS NOT NULL THEN ' via collector ' || v_collector_name ELSE '' END
      || ' — Bill #' || v_bill.bill_number || ' — ' || v_status_note
      || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;
  END IF;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, receipt_no)
  VALUES (v_account_id, NEW.paid_date, v_particular, 0, NEW.amount_pkr, 'payment', NEW.id, v_bill.bill_number, NEW.receipt_no);

  IF NEW.collected_by IS NOT NULL THEN
    v_cash_account_id := ensure_collector_account(NEW.collected_by);
  ELSE
    SELECT id INTO v_cash_account_id FROM accounts
    WHERE system = 'water_supply' AND code = (CASE WHEN NEW.method = 'cash' THEN 'WS-1001' ELSE 'WS-1002' END);
  END IF;
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, receipt_no)
    VALUES (v_cash_account_id, NEW.paid_date, v_particular, NEW.amount_pkr, 0, 'payment', NEW.id, v_bill.bill_number, NEW.receipt_no);
  END IF;

  IF NEW.bill_id IS NOT NULL THEN
    UPDATE bills SET
      paid_amount = v_total_paid,
      status = CASE WHEN v_total_paid >= v_net_payable THEN 'paid'
                    WHEN v_total_paid > 0 THEN 'partial'
                    ELSE v_bill.status END,
      paid_date = NEW.paid_date,
      payment_method = NEW.method
    WHERE id = NEW.bill_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_payment_delete_ledger() RETURNS trigger AS $$
DECLARE
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
  v_net_payable decimal;
BEGIN
  DELETE FROM ledger_entries WHERE reference_type = 'payment' AND reference_id = OLD.id;
  IF OLD.bill_id IS NOT NULL THEN
    SELECT * INTO v_bill FROM bills WHERE id = OLD.bill_id;
    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total_paid FROM payments WHERE bill_id = OLD.bill_id AND id != OLD.id;
    v_net_payable := v_bill.amount_pkr - COALESCE(v_bill.discount_amount, 0);
    UPDATE bills SET
      paid_amount = v_total_paid,
      status = CASE WHEN v_total_paid >= v_net_payable AND v_total_paid > 0 THEN 'paid'
                    WHEN v_total_paid > 0 THEN 'partial'
                    ELSE 'unpaid' END
    WHERE id = OLD.bill_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
